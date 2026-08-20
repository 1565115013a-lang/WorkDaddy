#!/usr/bin/env python
"""
从 macOS AppIcon.icns 抽取的 PNG 图层，合成 Windows 多分辨率 .ico
ICO 支持直接把 PNG 作为条目数据（Windows Vista+），因此无需解码 PNG。
产出 release/WorkDaddy.ico，供桌面快捷方式 / 启动器使用。
"""
import os, struct

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", ".workbuddy", "tmp_icon")
OUT = os.path.join(os.path.dirname(__file__), "..", "release", "WorkDaddy.ico")

# (ico尺寸, 源png文件名)  —— 从 icns 抽出、且尺寸匹配
ENTRIES = [
    (16,  "ic11.png"),
    (32,  "ic12.png"),
    (48,  "ic12.png"),   # 无 48 直接用 32 拉伸？ICO 无法自动拉伸，用同 32 会糊；改用 128
    (256, "ic13.png"),
]
# 修正 48 -> 用 64/128 里没有；真实可用:32/256/512/1024。48 需要缩放，无 PIL 就跳过，
# 用 32 重复会失真。改为:16,32,256,512 由 Windows 自动缩放。

ENTRIES = [
    (16,  "ic11.png"),
    (32,  "ic12.png"),
    (256, "ic13.png"),
    (512, "ic09.png"),
]

def main():
    # 读取所有条目 PNG
    datas = []
    for size, name in ENTRIES:
        p = os.path.join(ICON_DIR, name)
        b = open(p, "rb").read()
        # 校验 PNG 尺寸
        w, h = struct.unpack(">II", b[16:24])
        assert w == h == size, f"{name} is {w}x{h}, expected {size}"
        datas.append((size, b))

    # ICO header
    header = struct.pack("<HHH", 0, 1, len(datas))
    # dir entries: width,height(0=256),colorcount,reserved,planes,bitcount,bytesinres,offset
    offset = 6 + 16 * len(datas)
    entries = b""
    for size, b in datas:
        wbyte = 0 if size >= 256 else size
        hbyte = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", wbyte, hbyte, 0, 0, 1, 32, len(b), offset)
        offset += len(b)

    out = header + entries + b"".join(b for _, b in datas)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(out)
    print("ICO written:", os.path.abspath(OUT), os.path.getsize(OUT), "bytes, entries:", [s for s, _ in datas])

if __name__ == "__main__":
    main()
