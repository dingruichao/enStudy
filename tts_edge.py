#!/usr/bin/env python3
"""Edge TTS 流式助手：接收文本，用 edge-tts 生成英文整句 MP3 并写入 stdout。

用法:
  python tts_edge.py --text "一句英文" --voice en-US-AriaNeural --rate -10%
退出码:
  0  成功（stdout 为 MP3 二进制）
  2  合成失败（stderr 含 EDGE_ERR: 前缀）
"""
import argparse
import asyncio
import sys

import edge_tts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True, help="要朗读的英文整句")
    ap.add_argument("--voice", default="en-US-AriaNeural", help="Edge 嗓音名")
    ap.add_argument("--rate", default="-10%", help="语速，如 -10% / +0% / 15%")
    args = ap.parse_args()

    async def run():
        try:
            comm = edge_tts.Communicate(args.text, args.voice, rate=args.rate)
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("EDGE_ERR:" + str(e) + "\n")
            sys.exit(2)

    try:
        asyncio.run(run())
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("EDGE_ERR:" + str(e) + "\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
