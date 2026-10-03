#!/usr/bin/env python3
"""Convert the Chalice's in-game model (M2 + SKIN + BLP) to assets/model/chalice.glb.

    pip install pillow numpy
    python3 tools/m2_to_glb.py            # downloads the game files on first run (tools/.cache/)
    python3 tools/m2_to_glb.py --variant elite

The files come from wago.tools, which serves raw files from Blizzard's CDN by FileDataID.
How the IDs below were found (all tables from https://wago.tools/db2/<Table>/csv):

    ItemSparse              192207 "Eternal Gladiator's Chalice" (same appearances as 186778, Cosmic)
    ItemModifiedAppearance  modifier 159 -> appearance 44575 (base), 160 -> 44572 (elite)
    ItemAppearance          44575 -> ItemDisplayInfo 656600, 44572 -> 656603
    ItemDisplayInfo         ModelResourcesID 59920, ModelMaterialResourcesID 723631 / 723628
    ModelFileData           59920 -> 3885243 offhand_1h_progenitorraid_d_01.m2
    TextureFileData         723631 -> 3885260 (copper, base), 723628 -> 3885257 (silver, elite)

The M2's own SFID / TXID chunks name the skin (LOD 0) and the hard-coded textures.

What ends up in the GLB:
  * one skinned mesh, four primitives (gem, body, two additive shells), Y up, gem facing +Z
  * six joints and one 5 s "Stand" clip (the global-sequence hover and the orb's spin)
  * standard glTF materials, so any viewer shows something sensible
  * the original M2 shading in material extras.wow (combiner, vertex shader, blend mode, all
    texture slots, UV animation) and the glow emitter in node extras.wowParticle; the page reads these
"""
import argparse
import io
import json
import math
import pathlib
import struct
import urllib.request

import numpy as np
from PIL import Image

from m2 import M2, Skin

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools/.cache"

MODEL = 3885243
SKIN = 3885244
ITEM_TEXTURE = {"base": 3885260, "elite": 3885257}
WAGO = "https://wago.tools/api/casc/{}?download"

# Combiner and vertex shader for each M2 shader id this model uses (from the client's M2 shader table).
SHADERS = {
    0x8000: ("Combiners_Opaque_Mod2xNA_Alpha", "Diffuse_T1_Env"),
    0x8015: ("Combiners_Mod_Mod", "Diffuse_EdgeFade_T1_T2"),
    0x4011: ("Combiners_Mod_Mod", "Diffuse_T1_T2"),
}
PRIMITIVE_NAMES = ["gem", "body", "shell_edge", "shell"]
WRAP = {True: 10497, False: 33071}  # REPEAT, CLAMP_TO_EDGE


def fetch(fdid: int) -> bytes:
    path = CACHE / f"{fdid}.bin"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(WAGO.format(fdid), headers={"User-Agent": "chalice-archive build"})
        with urllib.request.urlopen(req, timeout=60) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def conv(v):
    """WoW model space (X forward, Y left, Z up) to glTF (X right, Y up, Z toward the viewer)."""
    return (v[1], v[2], v[0])


def quat(q):
    """M2CompQuat (int16 x4) to a unit quaternion in glTF axes."""
    x, y, z, w = ((c + 32768 if c < 0 else c - 32767) / 32767.0 for c in q)
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return (y, z, x, w)


def simplify(times, values, eps=1e-3):
    """Drop keys that linear interpolation between their neighbours reproduces within eps."""
    keep = [0]
    for i in range(1, len(times) - 1):
        t0, t1 = times[keep[-1]], times[i + 1]
        f = (times[i] - t0) / (t1 - t0)
        if any(abs(a + (b - a) * f - c) > eps for a, b, c in zip(values[keep[-1]], values[i + 1], values[i])):
            keep.append(i)
    keep.append(len(times) - 1)
    return [times[i] for i in keep], [values[i] for i in keep]


def encode(im: Image.Image, size=None, lossless=True) -> bytes:
    if size and im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    bio = io.BytesIO()
    if lossless:
        im.save(bio, "WEBP", lossless=True, method=6)
    else:
        im.save(bio, "WEBP", quality=88, method=6)
    return bio.getvalue()


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.gltf = {"asset": {"version": "2.0", "generator": "chalice-archive tools/m2_to_glb.py"},
                     "buffers": [], "bufferViews": [], "accessors": []}

    def view(self, data: bytes, target=None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            bv["target"] = target
        self.bin += data
        self.gltf["bufferViews"].append(bv)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, kind: str, ctype: int, target=None, normalized=False, minmax=False) -> int:
        data = np.ascontiguousarray(arr)
        acc = {"bufferView": self.view(data.tobytes(), target), "componentType": ctype,
               "count": int(data.shape[0]), "type": kind}
        if normalized:
            acc["normalized"] = True
        if minmax:
            flat = data.reshape(data.shape[0], -1)
            acc["min"] = [float(x) for x in flat.min(0)]
            acc["max"] = [float(x) for x in flat.max(0)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def write(self, path: pathlib.Path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.gltf, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin))
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(out)
        return len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=sorted(ITEM_TEXTURE), default="base", help="base = copper, elite = silver")
    ap.add_argument("--out", default=str(ROOT / "assets/model/chalice.glb"))
    args = ap.parse_args()

    m2 = M2(fetch(MODEL))
    skin = Skin(fetch(SKIN))
    txid = m2.chunk_u32("TXID")
    m2tex = m2.textures()
    mats = m2.materials()
    tex_combos = m2.u16list("texture_combos")
    transform_combos = m2.u16list("tex_transform_combos")
    gloops = m2.global_loops()
    g = GLB()

    # ---------- textures ----------
    images, textures, samplers, tex_of = [], [], {}, {}

    def texture(m2_index: int) -> int:
        """glTF texture index for M2 texture slot m2_index (type 0: file from TXID, type 2: the item's own texture)."""
        if m2_index in tex_of:
            return tex_of[m2_index]
        t = m2tex[m2_index]
        fdid = ITEM_TEXTURE[args.variant] if t["type"] == 2 else txid[m2_index]
        im = Image.open(io.BytesIO(fetch(fdid)))
        im.load()
        size, lossless = None, True
        if im.size[0] > 256:  # the 512 px shell noise is only ever seen as a faint shimmer
            size, lossless = 256, False
        images.append({"bufferView": g.view(encode(im, size, lossless)), "mimeType": "image/webp", "name": f"{fdid}"})
        key = (bool(t["flags"] & 1), bool(t["flags"] & 2))
        if key not in samplers:
            samplers[key] = len(samplers)
        textures.append({"sampler": samplers[key], "extensions": {"EXT_texture_webp": {"source": len(images) - 1}}, "name": f"{fdid}"})
        tex_of[m2_index] = len(textures) - 1
        return tex_of[m2_index]

    # ---------- geometry ----------
    verts = m2.vertices()
    local = skin.verts
    pos = np.array([conv(verts[j]["pos"]) for j in local], dtype=np.float32)
    nrm = np.array([conv(verts[j]["nrm"]) for j in local], dtype=np.float32)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    uv0 = np.array([verts[j]["uv0"] for j in local], dtype=np.float32)
    uv1 = np.array([verts[j]["uv1"] for j in local], dtype=np.float32)
    joints = np.array([verts[j]["bi"] for j in local], dtype=np.uint8)
    weights = np.array([verts[j]["bw"] for j in local], dtype=np.uint8)
    center = (pos.min(0) + pos.max(0)) / 2
    pos -= center

    a_pos = g.accessor(pos, "VEC3", 5126, 34962, minmax=True)
    a_nrm = g.accessor(nrm, "VEC3", 5126, 34962)
    a_uv0 = g.accessor(uv0, "VEC2", 5126, 34962)
    a_uv1 = g.accessor(uv1, "VEC2", 5126, 34962)
    a_jnt = g.accessor(joints, "VEC4", 5121, 34962)
    a_wgt = g.accessor(weights, "VEC4", 5121, 34962, normalized=True)

    primitives, materials = [], []
    for batch in skin.batches:
        sec = skin.sections[batch["section"]]
        idx = np.array(skin.indices[sec["istart"]:sec["istart"] + sec["icount"]], dtype=np.uint16)
        mat = mats[batch["material"]]
        pixel, vertex = SHADERS[batch["shader"]]
        slots = [tex_combos[batch["tex_combo"] + k] for k in range(batch["tex_count"])]
        gl_tex = [texture(s) for s in slots]
        uv_anim = []
        for k in range(batch["tex_count"]):
            ti = transform_combos[batch["transform_combo"] + k]
            if ti == 0xFFFF:
                uv_anim.append(None)
                continue
            tr = m2.tex_transforms()[ti]["tr"]
            times, values = simplify([t / 1000 for t in tr["times"][0]], [(v[0], v[1]) for v in tr["values"][0]])
            uv_anim.append({"period": gloops[tr["gseq"]] / 1000 if tr["gseq"] >= 0 else None, "times": times,
                            "translate": [[round(u, 6), round(v, 6)] for u, v in values]})
        name = PRIMITIVE_NAMES[len(materials)]
        blend = mat["blend"]
        gm = {"name": name,
              "pbrMetallicRoughness": {"baseColorTexture": {"index": gl_tex[0]}, "metallicFactor": 0.0, "roughnessFactor": 0.8},
              "doubleSided": bool(mat["flags"] & 0x4),
              "extras": {"wow": {"pixel": pixel, "vertex": vertex, "blend": blend, "flags": mat["flags"],
                                 "unlit": bool(mat["flags"] & 0x1), "depthWrite": not (mat["flags"] & 0x10),
                                 "textures": gl_tex, "uvAnim": uv_anim}}}
        if blend >= 2:
            gm["alphaMode"] = "BLEND"
        if mat["flags"] & 0x1:
            gm.setdefault("extensions", {})["KHR_materials_unlit"] = {}
        materials.append(gm)
        primitives.append({"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv0, "TEXCOORD_1": a_uv1,
                                          "JOINTS_0": a_jnt, "WEIGHTS_0": a_wgt},
                           "indices": g.accessor(idx, "SCALAR", 5123, 34963), "material": len(materials) - 1})

    # ---------- skeleton ----------
    bones = m2.bones()
    pivots = [np.array(conv(b["pivot"]), dtype=np.float64) - center for b in bones]
    nodes = []
    for i, b in enumerate(bones):
        parent_pivot = pivots[b["parent"]] if b["parent"] >= 0 else np.zeros(3)
        nodes.append({"name": f"bone{i}", "translation": [float(x) for x in pivots[i] - parent_pivot]})
    for i, b in enumerate(bones):
        if b["parent"] >= 0:
            nodes[b["parent"]].setdefault("children", []).append(i)
    ibm = np.zeros((len(bones), 16), dtype=np.float32)
    for i in range(len(bones)):
        mtx = np.eye(4, dtype=np.float32)
        mtx[:3, 3] = -pivots[i]
        ibm[i] = mtx.T.reshape(-1)  # column-major
    skin_idx = {"joints": list(range(len(bones))), "inverseBindMatrices": g.accessor(ibm, "MAT4", 5126)}

    # ---------- animation: the stand loop, driven by global sequences ----------
    channels, samplers_a = [], []
    clip_len = 0.0

    def add_channel(node, path, times, values, interp):
        nonlocal clip_len
        t = np.array(times, dtype=np.float32) / 1000
        clip_len = max(clip_len, float(t[-1]))
        out_kind = "VEC4" if path == "rotation" else "VEC3"
        samplers_a.append({"input": g.accessor(t, "SCALAR", 5126, minmax=True),
                           "output": g.accessor(np.array(values, dtype=np.float32), out_kind, 5126),
                           "interpolation": "STEP" if interp == 0 else "LINEAR"})
        channels.append({"sampler": len(samplers_a) - 1, "target": {"node": node, "path": path}})

    for i, b in enumerate(bones):
        base = np.array(nodes[i]["translation"])
        tr, ro = b["tr"], b["ro"]
        if tr["times"] and len(tr["times"][0]) > 1:
            add_channel(i, "translation", tr["times"][0], [base + np.array(conv(v)) for v in tr["values"][0]], tr["interp"])
        if ro["times"] and len(ro["times"][0]) > 1:
            add_channel(i, "rotation", ro["times"][0], [quat(q) for q in ro["values"][0]], ro["interp"])

    # ---------- glow emitter (one sprite stream at the orb's pivot) ----------
    em = m2.particles()[0]
    em_pos = np.array(conv(em["pos"])) - center
    emitter_node = {"name": "glow_emitter", "translation": [float(x) for x in em_pos - pivots[em["bone"]]],
                    "extras": {"wowParticle": {
                        "texture": texture(em["texture"]), "blend": em["blend"],
                        "lifespan": em["lifespan"], "rate": em["rate"], "area": [em["area_len"], em["area_wid"]],
                        "spinVary": em["base_spin_vary"],
                        "sizeScale": em["twinkle_scale"][0],
                        "color": {"t": em["color"][0], "v": [[c / 255 for c in v] for v in em["color"][1]]},
                        "alpha": {"t": em["alpha"][0], "v": em["alpha"][1]},
                        "scale": {"t": em["scale"][0], "v": em["scale"][1]}}}}
    nodes.append(emitter_node)
    nodes[em["bone"]].setdefault("children", []).append(len(nodes) - 1)

    nodes.append({"name": "skeleton", "children": [i for i, b in enumerate(bones) if b["parent"] < 0]})
    skin_idx["skeleton"] = len(nodes) - 1
    nodes.append({"name": "chalice", "mesh": 0, "skin": 0})
    mesh_node = len(nodes) - 1

    g.gltf.update({
        "scene": 0,
        "scenes": [{"name": "Eternal Gladiator's Chalice", "nodes": [skin_idx["skeleton"], mesh_node],
                    "extras": {"source": {"item": 192207, "variant": args.variant, "model": MODEL, "skin": SKIN,
                                          "itemTexture": ITEM_TEXTURE[args.variant], "m2": m2.name}}}],
        "nodes": nodes,
        "meshes": [{"name": "chalice", "primitives": primitives}],
        "skins": [skin_idx],
        "materials": materials,
        "images": images,
        "textures": textures,
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": WRAP[k[0]], "wrapT": WRAP[k[1]]}
                     for k, _ in sorted(samplers.items(), key=lambda kv: kv[1])],
        "animations": [{"name": "Stand", "channels": channels, "samplers": samplers_a}],
        "extensionsUsed": ["EXT_texture_webp", "KHR_materials_unlit"],
        "extensionsRequired": ["EXT_texture_webp"],
    })
    size = g.write(pathlib.Path(args.out))
    tris = sum(s["icount"] for s in skin.sections) // 3
    print(f"wrote {args.out}: {size / 1024:.0f} KB, {len(local)} vertices, {tris} triangles, "
          f"{len(bones)} joints, {len(channels)} channels over {clip_len:.2f} s")


if __name__ == "__main__":
    main()
