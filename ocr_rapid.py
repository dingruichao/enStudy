#!/usr/bin/env python3
"""RapidOCR 本地离线识别：读图片 → 输出「带坐标的文本行」JSON 到 stdout。

为什么要坐标：课本单词表常是双栏排版，纯文本 OCR 会把左右栏串行读乱。
带上每行四角坐标后，前端可以按 y 分行、按 x 分栏，正确还原阅读顺序。

用法:
  python ocr_rapid.py --file /tmp/x.jpg
  python ocr_rapid.py --file -            # 从 stdin 读图片二进制
输出 (stdout, JSON):
  {"ok":true,"lines":[{"text":"launch","score":0.98,"box":[[x,y]x4]}...],"elapse_ms":1234}
  {"ok":false,"error":"..."}
退出码: 0 成功 / 1 识别失败（含未安装依赖）
"""
import argparse
import json
import sys
import time


def load_engine():
    """兼容新旧两代 RapidOCR 包名与返回结构。"""
    # 新版（rapidocr 3.x，包名 rapidocr / rapidocr_onnxruntime 都导出 RapidOCR）
    try:
        from rapidocr_onnxruntime import RapidOCR as _R
        return _R(), 'onnxruntime'
    except ImportError:
        pass
    try:
        from rapidocr import RapidOCR as _R
        return _R(), 'rapidocr'
    except ImportError:
        pass
    return None, None


def normalize(result):
    """把不同版本的返回统一成 [(text, score, box), ...]。

    旧版: [(box, text, score), ...]           —— 元组
    新版: 对象，有 .boxes/.txts/.scores 或同名 key
    """
    out = []
    if result is None:
        return out
    # 新版对象：支持属性或字典取值
    boxes = txts = scores = None
    if hasattr(result, 'boxes'):
        boxes, txts, scores = result.boxes, result.txts, result.scores
    elif isinstance(result, dict):
        boxes = result.get('boxes')
        txts = result.get('texts') or result.get('txts')
        scores = result.get('scores')
    if boxes is not None and txts is not None:
        for i, t in enumerate(txts):
            b = boxes[i] if i < len(boxes) else None
            s = scores[i] if scores is not None and i < len(scores) else 1.0
            out.append((str(t), float(s), b))
        return out
    # 旧版：[(box, text, score), ...]
    for item in result:
        try:
            if len(item) == 3:
                box, text, score = item
                out.append((str(text), float(score), box))
        except Exception:
            continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True, help='图片路径；- 表示从 stdin 读二进制')
    ap.add_argument('--min-score', type=float, default=0.5, help='低于该置信度丢弃')
    args = ap.parse_args()

    t0 = time.time()
    engine, kind = load_engine()
    if engine is None:
        print(json.dumps({'ok': False,
                          'error': '未安装 rapidocr，请先 pip install rapidocr-onnxruntime'}))
        return 1

    try:
        if args.file == '-':
            import base64
            import tempfile
            import os
            data = sys.stdin.buffer.read()
            fd, tmp = tempfile.mkstemp(suffix='.img')
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            img_path = tmp
        else:
            img_path = args.file

        raw = engine(img_path)
        # 旧版返回 (result, elapse)，新版直接返回 result
        if isinstance(raw, tuple):
            raw = raw[0]
        items = normalize(raw)

        lines = []
        for text, score, box in items:
            if score < args.min_score:
                continue
            b = None
            if box is not None:
                try:
                    b = [[float(p[0]), float(p[1])] for p in box]
                except Exception:
                    b = None
            lines.append({'text': text, 'score': round(score, 4), 'box': b})

        print(json.dumps({
            'ok': True,
            'engine': kind,
            'lines': lines,
            'elapse_ms': int((time.time() - t0) * 1000)
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '{}: {}'.format(type(e).__name__, e)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
