# Checks assets/models/stem-player.glb against the viewer's contract by reading
# the file directly, so nothing depends on Blender's view of the scene.
#
#   python3 blender/verify_glb.py

import json
import os
import re
import struct
import sys

GLB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "assets", "models", "stem-player.glb")
COMPONENT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

failures = []


def check(ok, message):
    print(("ok   " if ok else "FAIL ") + message)
    if not ok:
        failures.append(message)


with open(GLB, "rb") as f:
    data = f.read()
magic, _, _ = struct.unpack("<III", data[:12])
check(magic == 0x46546C67, "GLB magic")
json_len = struct.unpack("<I", data[12:16])[0]
doc = json.loads(data[20:20 + json_len])
bin_chunk = data[20 + json_len + 8:]


def accessor(index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    fmt = COMPONENT[acc["componentType"]]
    width = WIDTH[acc["type"]]
    size = struct.calcsize("<" + fmt)
    stride = view.get("byteStride", size * width)
    out = []
    for i in range(acc["count"]):
        row = struct.unpack_from(f"<{width}{fmt}", bin_chunk, offset + i * stride)
        out.append(row if width > 1 else row[0])
    return out


nodes = {n.get("name"): n for n in doc["nodes"]}
expected = ["Body", "Btn_Center", "Btn_Dots", "Btn_Volume", "Btn_Load"]
expected += [f"LED_{arm}_{i}" for arm in "NESW" for i in range(1, 5)]
expected += [f"Hit_{arm}" for arm in "NESW"]
for name in expected:
    check(name in nodes, f"node {name}")
for name in nodes:
    check(re.fullmatch(r"[A-Za-z0-9_]+", name) is not None, f"three-safe name {name}")

materials = {m["name"]: m for m in doc["materials"]}
for name in ("Silicone", "LED"):
    check(name in materials, f"material {name}")
check("extensionsRequired" not in doc, f"no required extensions ({doc.get('extensionsRequired')})")
print("     extensions used:", doc.get("extensionsUsed", []))

tris = 0
for mesh in doc["meshes"]:
    for prim in mesh["primitives"]:
        tris += doc["accessors"][prim["indices"]]["count"] // 3
print(f"     size {len(data) / 1e6:.2f} MB, {tris} triangles, {len(nodes)} nodes")
check(len(data) < 8e6, "under 8 MB")


def prims(name):
    return doc["meshes"][nodes[name]["mesh"]]["primitives"]


def material_of(name):
    return doc["materials"][prims(name)[0]["material"]]["name"]


for name in nodes:
    check(len(prims(name)) == 1, f"{name} is a single primitive (a plain Mesh in three.js)")

for name in ("Body", "Btn_Center", "Btn_Dots", "Btn_Volume", "Btn_Load"):
    check(material_of(name) == "Silicone", f"{name} uses Silicone")
    check("COLOR_0" in prims(name)[0]["attributes"], f"{name} has COLOR_0")
    check("NORMAL" in prims(name)[0]["attributes"], f"{name} has normals")

for arm in "NESW":
    for i in range(1, 5):
        name = f"LED_{arm}_{i}"
        prim = prims(name)[0]
        check(material_of(name) == "LED", f"{name} uses LED")
        uv = accessor(prim["attributes"]["TEXCOORD_0"])
        us, vs = [p[0] for p in uv], [p[1] for p in uv]
        check(min(us) == 0 and max(us) == 1 and min(vs) == 0 and max(vs) == 1, f"{name} UV spans 0..1")


def to_blender(p):
    return (p[0], -p[2], p[1])


# Blender +X east, +Y north; glTF is (x, z, -y).
compass = {"N": (0, 1), "E": (1, 0), "S": (0, -1), "W": (-1, 0)}
last_r = {}
for arm, (dx, dy) in compass.items():
    previous = 0.0
    for i in range(1, 5):
        x, y, z = to_blender(nodes[f"LED_{arm}_{i}"]["translation"])
        along = x * dx + y * dy
        across = abs(-x * dy + y * dx)
        check(along > previous and across < 1e-5, f"LED_{arm}_{i} on its arm, index outward (r={along * 1000:.2f} mm)")
        previous = along

for name in ("Body", "Btn_Dots", "Btn_Volume", "Btn_Load", "Btn_Center"):
    node = nodes[name]
    prim = prims(name)[0]
    positions = accessor(prim["attributes"]["POSITION"])
    normals = accessor(prim["attributes"]["NORMAL"])
    indices = accessor(prim["indices"])
    agree = total = 0
    edges = {}
    for t in range(0, len(indices), 3):
        a, b, c = indices[t:t + 3]
        pa, pb, pc = positions[a], positions[b], positions[c]
        u = [pb[k] - pa[k] for k in range(3)]
        v = [pc[k] - pa[k] for k in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        area = sum(k * k for k in n)
        if area == 0:
            continue
        mean = [normals[a][k] + normals[b][k] + normals[c][k] for k in range(3)]
        total += 1
        agree += sum(n[k] * mean[k] for k in range(3)) > 0
    check(agree / total > 0.99, f"{name} winding matches normals ({agree}/{total})")

if "Body" in nodes:
    prim = prims("Body")[0]
    positions = accessor(prim["attributes"]["POSITION"])
    indices = accessor(prim["indices"])
    # The exporter splits vertices on normals/UVs, so weld by position first.
    weld = {}
    ids = [weld.setdefault(tuple(round(c, 7) for c in p), len(weld)) for p in positions]
    edges = {}
    for t in range(0, len(indices), 3):
        a, b, c = (ids[i] for i in indices[t:t + 3])
        for e in ((a, b), (b, c), (c, a)):
            key = (min(e), max(e))
            edges[key] = edges.get(key, 0) + 1
    open_edges = sum(1 for v in edges.values() if v == 1)
    check(open_edges == 0, f"Body is closed ({open_edges} open edges)")
    zs = [p[1] for p in positions]
    xs = [p[0] for p in positions]
    print(f"     Body size: {(max(xs) - min(xs)) * 1000:.2f} mm wide, {(max(zs) - min(zs)) * 1000:.2f} mm thick")

print("\nFAILED: " + "; ".join(failures) if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
