"""Minimal reader for chunked M2 models (MD21, Legion and later) and their .skin files.

Covers what tools/m2_to_glb.py needs: vertices, textures, materials, bones with their tracks,
texture transforms, and the first-generation particle emitter fields. Layouts follow
https://wowdev.wiki/M2 and https://wowdev.wiki/M2/.skin for header version 274.
"""
import struct


def arr(d, o):
    """M2Array: (count, offset)."""
    return struct.unpack_from('<II', d, o)


class M2:
    def __init__(self, raw: bytes):
        self.chunks = {}
        o = 0
        while o + 8 <= len(raw):
            tag = raw[o:o + 4].decode('latin1')
            size = struct.unpack_from('<I', raw, o + 4)[0]
            self.chunks[tag] = raw[o + 8:o + 8 + size]
            o += 8 + size
        d = self.d = self.chunks['MD21']
        assert d[:4] == b'MD20', d[:4]
        self.version = struct.unpack_from('<I', d, 4)[0]
        self.h = {}
        o = 8

        def take(*keys, kind='arr'):
            nonlocal o
            for k in keys:
                if kind == 'arr':
                    self.h[k] = arr(d, o)
                    o += 8
                else:
                    self.h[k] = struct.unpack_from('<I', d, o)[0]
                    o += 4

        take('name')
        take('global_flags', kind='u32')
        take('global_loops', 'sequences', 'seq_lookup', 'bones', 'bone_lookup', 'vertices')
        take('num_skins', kind='u32')
        take('colors', 'textures', 'tex_weights', 'tex_transforms', 'replaceable_lookup', 'materials', 'bone_combos',
             'texture_combos', 'tex_coord_combos', 'tex_weight_combos', 'tex_transform_combos')
        self.bbox = struct.unpack_from('<6f', d, o)
        self.bradius = struct.unpack_from('<f', d, o + 24)[0]
        o += 28 + 28  # bounding box/radius, collision box/radius
        take('coll_idx', 'coll_pos', 'coll_nrm', 'attachments', 'attach_lookup', 'events', 'lights', 'cameras',
             'camera_lookup', 'ribbons', 'particles')
        if self.h['global_flags'] & 0x8:
            take('tex_combiner_combos')
        n, off = self.h['name']
        self.name = d[off:off + n].rstrip(b'\0').decode('latin1')

    def chunk_u32(self, tag):
        c = self.chunks.get(tag, b'')
        return list(struct.unpack_from('<%dI' % (len(c) // 4), c))

    def u16list(self, k):
        n, off = self.h[k]
        return list(struct.unpack_from('<%dH' % n, self.d, off))

    def global_loops(self):
        n, off = self.h['global_loops']
        return list(struct.unpack_from('<%dI' % n, self.d, off))

    def vertices(self):
        n, off = self.h['vertices']
        out = []
        for i in range(n):
            p = off + i * 48
            uv = struct.unpack_from('<4f', self.d, p + 32)
            out.append(dict(pos=struct.unpack_from('<3f', self.d, p), bw=struct.unpack_from('<4B', self.d, p + 12),
                            bi=struct.unpack_from('<4B', self.d, p + 16), nrm=struct.unpack_from('<3f', self.d, p + 20),
                            uv0=uv[:2], uv1=uv[2:]))
        return out

    def textures(self):
        n, off = self.h['textures']
        out = []
        for i in range(n):
            t, flags, sn, so = struct.unpack_from('<IIII', self.d, off + i * 16)
            out.append(dict(type=t, flags=flags, name=self.d[so:so + sn].rstrip(b'\0').decode('latin1')))
        return out

    def materials(self):
        n, off = self.h['materials']
        return [dict(flags=f, blend=b) for f, b in (struct.unpack_from('<HH', self.d, off + 4 * i) for i in range(n))]

    def track(self, o, size, fmt):
        """M2Track<T>: interpolation, global sequence, per-sequence timestamps and values."""
        interp, gseq = struct.unpack_from('<Hh', self.d, o)
        tn, to = arr(self.d, o + 4)
        vn, vo = arr(self.d, o + 12)
        times, values = [], []
        for i in range(tn):
            n1, o1 = arr(self.d, to + 8 * i)
            times.append(list(struct.unpack_from('<%dI' % n1, self.d, o1)))
        for i in range(vn):
            n1, o1 = arr(self.d, vo + 8 * i)
            values.append([struct.unpack_from(fmt, self.d, o1 + size * j) for j in range(n1)])
        return dict(interp=interp, gseq=gseq, times=times, values=values)

    def fblock(self, o, size, fmt):
        """M2PartTrack<T>: fixed16 timestamps (fraction of particle life) and values."""
        tn, to = arr(self.d, o)
        vn, vo = arr(self.d, o + 8)
        times = [struct.unpack_from('<h', self.d, to + 2 * i)[0] / 32767 for i in range(tn)]
        values = [struct.unpack_from(fmt, self.d, vo + size * i) for i in range(vn)]
        return times, values

    def bones(self):
        n, off = self.h['bones']
        out = []
        for i in range(n):
            p = off + i * 88
            key, flags, parent, submesh = struct.unpack_from('<iIhH', self.d, p)
            out.append(dict(key=key, flags=flags, parent=parent,
                            tr=self.track(p + 16, 12, '<3f'), ro=self.track(p + 36, 8, '<4h'), sc=self.track(p + 56, 12, '<3f'),
                            pivot=struct.unpack_from('<3f', self.d, p + 76)))
        return out

    def tex_transforms(self):
        n, off = self.h['tex_transforms']
        return [dict(tr=self.track(off + 60 * i, 12, '<3f'), ro=self.track(off + 60 * i + 20, 16, '<4f'),
                     sc=self.track(off + 60 * i + 40, 12, '<3f')) for i in range(n)]

    def particles(self):
        """The subset of M2Particle this project uses. Tracks are read as their first (static) value."""
        n, off = self.h['particles']
        out = []
        for i in range(n):
            p = off + i * 492
            first = lambda o: (self.track(o, 4, '<f')['values'] or [[(0.0,)]])[0][0][0]
            twinkle = struct.unpack_from('<11f', self.d, p + 348)
            out.append(dict(
                flags=struct.unpack_from('<I', self.d, p + 4)[0],
                pos=struct.unpack_from('<3f', self.d, p + 8),
                bone=struct.unpack_from('<H', self.d, p + 20)[0],
                texture=struct.unpack_from('<H', self.d, p + 22)[0],
                blend=self.d[p + 40], emitter_type=self.d[p + 41],
                speed=first(p + 52), lifespan=first(p + 152), rate=first(p + 176),
                area_len=first(p + 200), area_wid=first(p + 220),
                color=self.fblock(p + 260, 12, '<3f'),
                alpha=(lambda t, v: (t, [x[0] / 32767 for x in v]))(*self.fblock(p + 276, 2, '<h')),
                scale=(lambda t, v: (t, [x[0] for x in v]))(*self.fblock(p + 292, 8, '<2f')),
                twinkle_scale=twinkle[3:5], base_spin_vary=twinkle[8],
            ))
        return out


class Skin:
    def __init__(self, d: bytes):
        assert d[:4] == b'SKIN', d[:4]
        vn, vo = arr(d, 4)
        in_, io = arr(d, 12)
        sn, so = arr(d, 28)
        tn, to = arr(d, 36)
        self.verts = list(struct.unpack_from('<%dH' % vn, d, vo))
        self.indices = list(struct.unpack_from('<%dH' % in_, d, io))
        self.sections = []
        for i in range(sn):
            f = struct.unpack_from('<10H3f3ff', d, so + 48 * i)
            self.sections.append(dict(id=f[0], vstart=f[2] + (f[1] << 16), vcount=f[3], istart=f[4] + (f[1] << 16),
                                      icount=f[5], center_bone=f[9], center=f[10:13]))
        self.batches = []
        for i in range(tn):
            f = struct.unpack_from('<BbHHHHHHHHHHH', d, to + 24 * i)
            self.batches.append(dict(flags=f[0], priority=f[1], shader=f[2], section=f[3], color=f[5], material=f[6],
                                     layer=f[7], tex_count=f[8], tex_combo=f[9], coord_combo=f[10], weight_combo=f[11],
                                     transform_combo=f[12]))
