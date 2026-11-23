import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import slicer as sl  # noqa: E402


def fake_gcode(n, h1=0.2, h=0.2, bbl=False):
    out = ["; HEADER_BLOCK_START", "; total filament used [g] = 12.34",
           "; estimated printing time (normal mode) = 1h 2m 3s", "G28", "M83"]
    z = 0.0
    for i in range(n):
        hh = h1 if i == 0 else h
        z = round(z + hh, 4)
        out += ["; CHANGE_LAYER", f"; Z_HEIGHT: {z:g}" if bbl else f";Z:{z:g}", f";HEIGHT:{hh:g}",
                "G1 E-.8 F1800", f"G1 Z{z:g} F600", ";_SET_FAN_SPEED_CHANGING_LAYER",
                "; FEATURE: Outer wall", "G1 X10 Y10 E1", "; FEATURE: Inner wall", "G1 X20 Y10 E1"]
    out += ["M104 S0"]
    return "\n".join(out) + "\n"


def layer_of_m600(gcode):
    lines = gcode.splitlines()
    layers = sl.parse_layers(lines)
    res = []
    for i, ln in enumerate(lines):
        if ln == "M600":
            k = max(j for j, L in enumerate(layers) if L.start < i) + 1
            # el M600 tiene que ir antes de imprimir nada de esa capa
            seg = lines[layers[k - 1].start:i]
            assert not any(s.startswith("G1 X") for s in seg)
            res.append(k)
    return res


@pytest.mark.parametrize("n,expected", [(150, 76), (151, 76), (10, 6), (11, 6), (3, 2)])
def test_half_rounds_up(n, expected):
    assert sl.fraction_layer(n, 0.5) == expected
    g, ins, w = sl.insert_color_changes(fake_gcode(n), [sl.ColorChange(fraction=0.5, color="#ff0000")])
    assert layer_of_m600(g) == [expected]
    assert ins[0]["layer"] == expected and not w


def test_multiple_and_bbl_markers():
    g, ins, _ = sl.insert_color_changes(fake_gcode(100, bbl=True),
                                        [sl.ColorChange(layer=30, color="#111111"),
                                         sl.ColorChange(layer=70, color="#222222")])
    assert layer_of_m600(g) == [30, 70]
    assert g.count("M600") == 2
    assert "-> #222222" in g


def test_thirds():
    n = 100
    chs = [sl.ColorChange(fraction=k / 3) for k in (1, 2)]
    g, ins, _ = sl.insert_color_changes(fake_gcode(n), chs)
    assert [c["layer"] for c in ins] == [34, 67]


def test_relocate_by_z_when_layer_count_differs():
    # previsto con capas de 0.2 (capa 26 empieza en Z=5.0), pero Orca usó 0.1
    g, ins, w = sl.insert_color_changes(fake_gcode(200, h1=0.2, h=0.1),
                                        [sl.ColorChange(layer=26, z=5.0)], predicted_layers=100)
    assert w and ins[0]["z"] == pytest.approx(5.0, abs=1e-6)
    assert layer_of_m600(g) == [ins[0]["layer"]]


def test_out_of_range_is_ignored():
    g, ins, w = sl.insert_color_changes(fake_gcode(10), [sl.ColorChange(layer=50)])
    assert "M600" not in g and w


def test_stats():
    st = sl.gcode_stats(fake_gcode(5))
    assert st["grams"] == pytest.approx(12.34) and st["time"] == "1h 2m 3s"


def test_layer_count_and_bottoms():
    assert sl.layer_count(10.0, 0.2, 0.2) == 50
    assert sl.layer_count(10.05, 0.2, 0.2) == 51
    assert sl.layer_bottom_z(1, 0.2, 0.3) == 0
    assert sl.layer_bottom_z(2, 0.2, 0.3) == pytest.approx(0.3)
    assert sl.layer_bottom_z(3, 0.2, 0.3) == pytest.approx(0.5)


@pytest.mark.parametrize("n", [[0, 0, -1], [0, 0, 1], [0.835, 0, -0.551], [1, 0, 0], [0.3, -0.5, 0.8]])
def test_base_rotation(n):
    R = sl.base_rotation(n)
    v = np.asarray(n, float) / np.linalg.norm(n)
    assert np.allclose(R @ v, [0, 0, -1])
    assert np.allclose(R @ R.T, np.eye(3)) and np.linalg.det(R) == pytest.approx(1)


def test_resolve_and_flatten(tmp_path):
    sysdir = tmp_path / "resources" / "profiles" / "Vendor" / "process"
    sysdir.mkdir(parents=True)
    (sysdir / "fdm_process_common.json").write_text(json.dumps(
        {"name": "fdm_process_common", "type": "process", "from": "system", "layer_height": "0.2",
         "initial_layer_print_height": "0.2", "wall_loops": "2"}))
    (sysdir / "0.20mm Standard @Vendor.json").write_text(json.dumps(
        {"name": "0.20mm Standard @Vendor", "inherits": "fdm_process_common", "from": "system",
         "wall_loops": "3", "compatible_printers": ["X"]}))
    user = tmp_path / "user" / "123" / "process"
    user.mkdir(parents=True)
    up = user / "Mi perfil.json"
    up.write_text(json.dumps({"name": "Mi perfil", "inherits": "0.20mm Standard @Vendor",
                              "from": "User", "layer_height": "0.16"}))
    idx = sl.PresetIndex([tmp_path / "user", tmp_path / "resources" / "profiles"])
    flat = sl.flatten_preset(up, "process", idx)
    assert flat["layer_height"] == "0.16" and flat["wall_loops"] == "3"
    assert flat["inherits"] == "" and flat["from"] == "User" and flat["type"] == "process"
    assert "compatible_printers" not in flat
    assert sl.layer_heights(flat) == (0.16, 0.2)
    assert sl.list_presets(tmp_path)["process"][0]["name"] == "Mi perfil"


@pytest.mark.parametrize("fractions,expected", [
    ((1 / 4, 3 / 4), [79, 237]),   # España
    ((2 / 5,), [127]),             # Portugal
    ((1 / 3, 2 / 3), [106, 211]),  # Francia, Alemania, Italia
])
def test_flag_fractions(fractions, expected):
    g, ins, w = sl.insert_color_changes(fake_gcode(315), [sl.ColorChange(fraction=f) for f in fractions])
    assert [c["layer"] for c in ins] == expected and layer_of_m600(g) == expected and not w
