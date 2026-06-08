#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import random
import re
import time
import urllib.request
import urllib.parse
import http.cookiejar
from dataclasses import dataclass
from io import BytesIO
from typing import Dict, List, Sequence
from urllib.parse import parse_qs, urlencode, urlparse

try:
    from PIL import Image, ImageDraw
except ModuleNotFoundError as e:
    raise SystemExit("Missing Pillow. Use bundled Python or install pillow.") from e

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~"
API = "https://iv.jd.com"
REFERER = "https://passport.jd.com/"


def jsonp_loads(text: str) -> dict:
    text = text.strip()
    m = re.match(r"^[\w.$]+\((.*)\)\s*;?$", text, re.S)
    return json.loads(m.group(1) if m else text)


def callback(name: str = "jsonp") -> str:
    return f"{name}_{str(random.random()).replace('.', '')}"


def string10to64(value: int) -> str:
    value = int(abs(value))
    out = []
    while True:
        mod = value % 64
        value = (value - mod) // 64
        out.insert(0, ALPHABET[mod])
        if not value:
            break
    return "".join(out)


def prefix_integer(s: str, width: int) -> str:
    # JD JS: (Array(width).join(0) + s).slice(-width)
    return (("0" * (width - 1)) + s)[-width:]


def pretreatment(value: int, width: int, unsigned: bool) -> str:
    value = int(value)
    sign = "" if unsigned else ("1" if value > 0 else "0")
    return sign + prefix_integer(string10to64(abs(value)), width)


def get_coordinate(points: Sequence[Sequence[int]]) -> str:
    out: List[str] = []
    for i, p in enumerate(points):
        x, y, t = map(int, p[:3])
        if i == 0:
            out.append(pretreatment(min(x, 0x3FFFF), 3, True))
            out.append(pretreatment(min(y, 0xFFFFFF), 4, True))
            out.append(pretreatment(min(t, 0x3FFFFFFFFFF), 7, True))
        else:
            px, py, pt = map(int, points[i - 1][:3])
            out.append(pretreatment(min(x - px, 0xFFF), 2, False))
            out.append(pretreatment(min(y - py, 0xFFF), 2, False))
            out.append(pretreatment(min(t - pt, 0xFFFFFF), 4, True))
    return "".join(out)


def decode_image(s: str, cookie: str = "") -> Image.Image:
    # g.html normally returns raw base64 PNG strings, but live DOM may contain data URLs
    # or static image URLs such as //ivs.jd.com/slide/images/xxx.png.
    if s.startswith("//") or s.startswith("http://") or s.startswith("https://"):
        url = "https:" + s if s.startswith("//") else s
        headers = {"User-Agent": UA, "Referer": REFERER, "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"}
        if cookie:
            headers["Cookie"] = cookie
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
        return Image.open(BytesIO(raw)).convert("RGBA")
    return Image.open(BytesIO(base64.b64decode(s.split(",")[-1]))).convert("RGBA")


def luminance(rgb):
    r, g, b = rgb[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def gradient_matrix(img: Image.Image):
    gray = img.convert("L")
    w, h = gray.size
    pix = gray.load()
    g = [[0.0] * w for _ in range(h)]
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            gx = pix[x + 1, y] - pix[x - 1, y]
            gy = pix[x, y + 1] - pix[x, y - 1]
            g[y][x] = math.sqrt(gx * gx + gy * gy)
    return g


def edge_match_gap(bg: Image.Image, patch: Image.Image) -> dict:
    bg_rgb = bg.convert("RGB")
    patch_rgb = patch.convert("RGB")
    bw, bh = bg_rgb.size
    pw, ph = patch_rgb.size
    gb = gradient_matrix(bg_rgb)
    gp = gradient_matrix(patch_rgb)
    flat_p = [gp[y][x] for y in range(ph) for x in range(pw)]
    p_mean = sum(flat_p) / len(flat_p)
    p0 = [v - p_mean for v in flat_p]
    p_den = math.sqrt(sum(v * v for v in p0)) or 1.0
    best = (-999.0, 0, 0)
    top = []
    for yy in range(0, bh - ph + 1):
        for xx in range(30, bw - pw):
            vals = [gb[yy + y][xx + x] for y in range(ph) for x in range(pw)]
            mean = sum(vals) / len(vals)
            v0 = [v - mean for v in vals]
            den = math.sqrt(sum(v * v for v in v0)) * p_den
            if not den:
                continue
            score = sum(a * b for a, b in zip(v0, p0)) / den
            if score > best[0]:
                best = (score, xx, yy)
            top.append((score, xx, yy))
    top.sort(reverse=True)
    return {"score": best[0], "x": best[1], "y": best[2], "top": top[:10]}


def dark_component_gap(bg: Image.Image, y_hint: int | None = None) -> dict:
    im = bg.convert("RGB")
    w, h = im.size
    if y_hint is None:
        yr = range(0, h)
    else:
        yr = range(max(0, y_hint - 20), min(h, y_hint + 70))
    hist = []
    for x in range(20, w - 20):
        s = 0
        for y in yr:
            if luminance(im.getpixel((x, y))) < 70:
                s += 1
        hist.append((s, x))
    best = max((sum(v for v, _ in hist[max(0, i - 16): i + 17]), x) for i, (_, x) in enumerate(hist))
    return {"score": best[0], "x": best[1]}


def estimate_gap(bg: Image.Image, patch: Image.Image, y_hint: int | None, ui_width: int) -> dict:
    edge = edge_match_gap(bg, patch)
    dark = dark_component_gap(bg, y_hint)
    # Prefer edge match when it aligns with the server y hint. Dark histogram often locks onto
    # decorative dark areas, so use it only when edge matching is very weak/off-row.
    edge_y_ok = y_hint is None or abs(edge["y"] - int(y_hint)) <= 25
    # Very-left edge matches are often false positives from dark foreground objects
    # (person/tree/building). JD slide targets are normally placed away from the
    # initial knob area, so fall back to the dark-component hole candidate there.
    if edge["x"] < 60 and dark.get("score", 0) > 300:
        chosen = dark["x"]
    else:
        chosen = edge["x"] if (edge["score"] >= 0.15 and edge_y_ok) else dark["x"]
    ui_first_last = chosen * ui_width / bg.size[0]
    # JD drag points use viewport clientX: first point is slideBtn left, second is mousedown center,
    # and subsequent movement CSS offset is clientX - disX. Therefore the effective drag
    # distance equals the scaled gap x itself, not gap_x - center_offset.
    down_distance = round(ui_first_last)
    return {
        "edge": edge,
        "dark": dark,
        "chosen_x_bg": chosen,
        "ui_first_last": ui_first_last,
        "down_distance": max(1, int(down_distance)),
    }


def make_mouse_pos(slider_left: int, slider_top: int, down_distance: int, *, duration_ms: int | None = None) -> List[List[int]]:
    """Recreate JD mousePos shape.

    JD first pushes [getLeft(slideBtn), getTop(slideBtn), t], then mousedown [clientX, clientY, t].
    Defaults match observed login iframe: slideBtn left/top around 0/156, mousedown around 28/185.
    """
    if duration_ms is None:
        duration_ms = random.randint(1150, 1750)
    t0 = int(time.time() * 1000)
    center_offset = 28
    down_x = slider_left + center_offset
    down_y = slider_top + 29
    points: List[List[int]] = [
        [slider_left, slider_top, t0],
        [down_x, down_y, t0 + random.randint(0, 5)],
    ]
    steps = random.randint(45, 70)
    last_x, last_y = down_x, down_y
    for i in range(1, steps + 1):
        p = i / steps
        # ease-out, then small correction/overshoot zone
        x_float = down_x + down_distance * (1 - (1 - p) ** 2.35)
        if 0.70 < p < 0.93:
            x_float += math.sin((p - 0.70) / 0.23 * math.pi) * random.uniform(1.0, 2.8)
        x = round(x_float)
        if i == steps:
            x = down_x + down_distance
        y = down_y + round(math.sin(p * math.pi * 3.2) * random.uniform(0.8, 2.2)) + (1 if i % 19 == 0 else 0)
        t = t0 + 180 + round(duration_ms * p) + random.randint(-5, 8)
        if x != last_x or y != last_y:
            points.append([x, y, t])
            last_x, last_y = x, y
    points.append([down_x + down_distance, down_y + random.choice([0, 0, 1, -1]), t0 + duration_ms + random.randint(240, 620)])
    return points


def qp(url: str) -> Dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def raw_query(params: Dict[str, str]) -> str:
    # JD jsonp() uses k + "=" + v without encodeURIComponent. Values such as u are already encoded.
    return "&".join(f"{k}={v}" for k, v in params.items())



SEQ_ALPHABET = "23IL<N01c7KvwZO56RSTAfghiFyzWJqVabGH4PQdopUrsCuX*xeBjkltDEmn89.-"

def js_encode_uri_component(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe="-_.!~*'()")

def js_encode_uri(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe=";/?:@&=+$,#-_.!~*'()")

def seq_char(index) -> str:
    try:
        if index is None or math.isnan(index):
            index = 0
    except TypeError:
        pass
    index = int(index)
    return SEQ_ALPHABET[index] if 0 <= index < len(SEQ_ALPHABET) else ""

def seq_e(payload: str) -> str:
    # Exact port of seq/s.js E(): do...while(d <= encoded.length), no '=' padding.
    a = js_encode_uri_component(payload)
    out = []
    d = 0
    while True:
        h = ord(a[d]) if d < len(a) else float("nan"); d += 1
        f = ord(a[d]) if d < len(a) else float("nan"); d += 1
        e = ord(a[d]) if d < len(a) else float("nan"); d += 1
        k = 0 if math.isnan(h) else (int(h) >> 2)
        h2 = float("nan") if math.isnan(h) else (((int(h) & 3) << 4) | (0 if math.isnan(f) else (int(f) >> 4)))
        l = (0 if math.isnan(f) else ((int(f) & 15) << 2)) | (0 if math.isnan(e) else (int(e) >> 6))
        c = 64 if math.isnan(e) else (int(e) & 63)
        if math.isnan(f):
            l = c = 64
        out.extend([seq_char(k), seq_char(h2), seq_char(l), seq_char(c)])
        if not (d <= len(a)):
            break
    return "".join(out) + "/"

def seq_c(obj: Dict[str, object]) -> str:
    parts = []
    for k, v in obj.items():
        if isinstance(v, str):
            parts.append(f"'{k}':'{v}'")
        else:
            parts.append(f"'{k}':{v}")
    return seq_e("{" + ",".join(parts) + "}")

def build_seq_obj(*, biz_id: str, element_id: str, seq: str, session_id: str, eid: str, val: str, sp: int, special: str | None = None, ctime: int | None = None) -> Dict[str, object]:
    obj: Dict[str, object] = {}
    obj["version"] = "1.0"
    obj["bizId"] = biz_id
    obj["elementId"] = element_id
    obj["seq"] = seq
    if special is not None:
        obj["special"] = special
    obj["sessionId"] = session_id
    obj["sp"] = sp
    obj["eid"] = eid
    obj["val"] = val
    obj["ctime"] = int(ctime or int(time.time() * 1000))
    return obj

def send_seq_warmup(session: SimpleSession, *, cookie: str, biz_id: str, session_id: str, eid: str, loc: str, username: str, password: str = "", base_sp: int = 1) -> List[dict]:
    events = []
    now = int(time.time() * 1000)
    # Approximate the seq chain observed on the login iframe: global focus + input/focus/change/keyup + submit click.
    specs = [
        ("0", "scroll", "0", "1", None),
        ("loginname", "focus", "0", "1", None),
        ("loginname", "input", "0", str(len(username)), None),
        ("loginname", "change", "0", str(len(username)), None),
        ("loginname", "keyup", "0", "b", None),
        ("loginname", "sniffV", "0", username, None),
        ("nloginpwd", "focus", "1", "1", None),
        ("nloginpwd", "input", "1", str(len(password) if password else 12), None),
        ("nloginpwd", "change", "1", str(len(password) if password else 12), None),
        ("nloginpwd", "keyup", "1", "b", None),
        ("nloginpwd", "sniffL", "1", f"{len(password) if password else 12}_a_a", None),
        ("loginsubmit", "click", "0", "1", None),
    ]
    for idx, (element, seq, special, val, _) in enumerate(specs):
        obj = build_seq_obj(biz_id=biz_id, element_id=element, seq=seq, special=special, session_id=session_id, eid=eid, val=val, sp=base_sp + idx, ctime=now + idx * random.randint(80, 180))
        d = seq_c(obj)
        url = "https://seq.jd.com/jseq.html?" + raw_query({"d": urllib.parse.quote(d, safe="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._/"), "p": "", "loc": js_encode_uri(loc), "callback": callback()})
        text = http_get(session, url, cookie)
        events.append({"seq": seq, "elementId": element, "url": url, "response": text[:200]})
        time.sleep(random.uniform(0.03, 0.09))
    return events


def extract_real_seq_objects(live: dict | None, seq_json_path: str | None = None) -> list[dict]:
    data = None
    if seq_json_path:
        with open(seq_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    elif live:
        data = live.get("seqObjs") or live.get("seq_objects")
        if data is None and isinstance(live.get("codexLogs"), dict):
            data = live["codexLogs"].get("seqObjs")
    if not data:
        return []
    out: list[dict] = []
    for item in data:
        obj = None
        if isinstance(item, dict):
            if isinstance(item.get("ret"), dict):
                obj = item["ret"]
            elif isinstance(item.get("obj"), dict):
                obj = item["obj"]
            elif all(k in item for k in ("bizId", "elementId", "seq")):
                obj = item
        if not obj:
            continue
        # Keep JD's key insertion order as much as possible. joinReturnObj returns this order.
        ordered: Dict[str, object] = {}
        for k in ["bizId", "elementId", "seq", "sessionId", "special", "sp", "version", "eid", "val", "ctime"]:
            if k in obj:
                ordered[k] = obj[k]
        for k, v in obj.items():
            if k not in ordered:
                ordered[k] = v
        out.append(ordered)
    return out

def send_seq_objects(session: SimpleSession, objects: list[dict], *, cookie: str, loc: str, rewrite_time: bool = False) -> List[dict]:
    events = []
    if not objects:
        return events
    base_ctime = int(time.time() * 1000)
    first_ctime = int(objects[0].get("ctime") or base_ctime)
    for idx, obj in enumerate(objects):
        send_obj = dict(obj)
        if rewrite_time:
            try:
                delta = int(send_obj.get("ctime") or first_ctime) - first_ctime
            except Exception:
                delta = idx * 80
            send_obj["ctime"] = base_ctime + max(0, delta)
        d = seq_c(send_obj)
        url = "https://seq.jd.com/jseq.html?" + raw_query({"d": urllib.parse.quote(d, safe="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._/"), "p": "", "loc": js_encode_uri(loc), "callback": callback()})
        text = http_get(session, url, cookie)
        events.append({"seq": send_obj.get("seq"), "elementId": send_obj.get("elementId"), "obj": send_obj, "url": url, "response": text[:200]})
        time.sleep(random.uniform(0.02, 0.06))
    return events

def build_g_url(args) -> str:
    if args.g_url:
        return args.g_url
    params = {
        "appId": args.app_id,
        "scene": args.scene,
        "product": args.product,
        "e": args.eid,
        "j": args.jstk,
        "lang": args.lang,
        "callback": callback(),
    }
    return f"{API}/slide/g.html?" + urlencode(params)


def build_s_url(g_url: str, s_template: str | None, challenge: str, d: str, w: int, args) -> str:
    gp = qp(g_url)
    sp = qp(s_template) if s_template else {}
    params = {
        "d": d,
        "c": challenge,
        "w": str(w),
        "appId": gp.get("appId") or sp.get("appId") or args.app_id,
        "scene": gp.get("scene") or sp.get("scene") or args.scene,
        "product": gp.get("product") or sp.get("product") or args.product,
        "e": gp.get("e") or sp.get("e") or args.eid,
        "j": gp.get("j") or sp.get("j") or args.jstk,
        "s": args.session_id or sp.get("s", ""),
        "o": args.origin or sp.get("o", ""),
        "o1": args.o1 or sp.get("o1", "0"),
        "u": args.return_url or sp.get("u", ""),
        "lang": gp.get("lang") or sp.get("lang") or args.lang,
        "callback": callback(),
    }
    return f"{API}/slide/s.html?" + raw_query(params)


class SimpleSession:
    def __init__(self):
        self.cookiejar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookiejar))

    def get_text(self, url: str, headers: dict | None = None, timeout: int = 20) -> str:
        req = urllib.request.Request(url, headers=headers or {})
        with self.opener.open(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")


def http_get(session: SimpleSession, url: str, cookie: str = "") -> str:
    headers = {"User-Agent": UA, "Referer": REFERER, "Accept": "*/*"}
    if cookie:
        headers["Cookie"] = cookie
    return session.get_text(url, headers=headers, timeout=20)


def save_debug(out_dir: str, bg: Image.Image, patch: Image.Image, gap: dict):
    os.makedirs(out_dir, exist_ok=True)
    bg.save(os.path.join(out_dir, "bg.png"))
    patch.save(os.path.join(out_dir, "patch.png"))
    ann = bg.convert("RGB")
    draw = ImageDraw.Draw(ann)
    x = gap["chosen_x_bg"]
    draw.rectangle([x, 0, x + patch.size[0], patch.size[1] + 90], outline="red", width=2)
    draw.text((x, 2), f"x={x}", fill="red")
    ann.save(os.path.join(out_dir, "annotated_gap.png"))
    with open(os.path.join(out_dir, "gap.json"), "w", encoding="utf-8") as f:
        json.dump(gap, f, ensure_ascii=False, indent=2, default=str)


def main():
    ap = argparse.ArgumentParser(description="Pure-protocol JD iv.jd.com slide chain PoC")
    ap.add_argument("--g-url", help="fresh captured /slide/g.html URL")
    ap.add_argument("--live-json", help="browser-extracted live state JSON with challenge/imgs/e/j/s/cookie")
    ap.add_argument("--s-template", help="captured /slide/s.html URL template carrying s/o/u etc")
    ap.add_argument("--app-id", default="1604ebb2287")
    ap.add_argument("--scene", default="login")
    ap.add_argument("--product", default="click-bind-suspend")
    ap.add_argument("--eid", default="")
    ap.add_argument("--jstk", default="")
    ap.add_argument("--session-id", default="")
    ap.add_argument("--origin", default="your_username", help="s.html o param, usually encoded loginname")
    ap.add_argument("--return-url", default="", help="raw return URL value; if omitted, copied from --s-template")
    ap.add_argument("--o1", default="0")
    ap.add_argument("--lang", default="zh_CN")
    ap.add_argument("--cookie", default="", help="Cookie header copied from browser /slide/g.html or /slide/s.html request")
    ap.add_argument("--w", type=int, default=281)
    ap.add_argument("--slider-left", type=int, default=0)
    ap.add_argument("--slider-top", type=int, default=156)
    ap.add_argument("--distance", type=int, help="override down-distance in UI pixels")
    ap.add_argument("--out", default="work/protocol_chain/out_py")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--warm-seq", action="store_true", help="send approximate seq.jd.com behavior chain before s.html")
    ap.add_argument("--seq-json", help="JSON file containing real seqObjs captured from browser; overrides approximate warm-seq")
    ap.add_argument("--rewrite-seq-time", action="store_true", help="rewrite captured seq ctime to current time while preserving deltas")
    ap.add_argument("--password-len", type=int, default=12)
    args = ap.parse_args()
    args.loc = getattr(args, "loc", None) or "https://passport.jd.com/common/loginPage?from=jbm_jd&ReturnUrl=https%3A%2F%2Fjzt.jd.com%2Fhome%2F"

    session = SimpleSession()
    live = None
    if args.live_json:
        with open(args.live_json, "r", encoding="utf-8") as f:
            live = json.load(f)
        if not args.cookie:
            args.cookie = live.get("cookie", "")
        g_url = args.g_url or "https://iv.jd.com/slide/g.html?" + urlencode({
            "appId": live.get("params", {}).get("appId", args.app_id),
            "scene": live.get("params", {}).get("scene", args.scene),
            "product": live.get("params", {}).get("product", args.product),
            "e": live.get("eid", args.eid),
            "j": live.get("jstk", args.jstk),
            "lang": live.get("params", {}).get("lang", args.lang),
            "callback": callback(),
        })
        bg = decode_image(live["imgs"][0]["src"], args.cookie)
        patch = decode_image(live["imgs"][1]["src"], args.cookie)
        y = int(live.get("y") or 0)
        challenge = live["challenge"]
        args.w = int(live.get("width") or args.w)
        args.eid = live.get("eid") or args.eid
        args.jstk = live.get("jstk") or args.jstk
        args.session_id = live.get("sessionId") or args.session_id
        args.origin = live.get("originValue") or args.origin
        args.o1 = str(live.get("selenium") or args.o1)
        args.return_url = live.get("urlParam") or args.return_url
        args.loc = live.get("href") or args.return_url
        args.product = live.get("params", {}).get("product", args.product)
        args.scene = live.get("params", {}).get("scene", args.scene)
        args.app_id = live.get("params", {}).get("appId", args.app_id)
        if not args.cookie:
            args.cookie = live.get("cookie", "")
        if live.get("slideBtn"):
            args.slider_left = int(round(float(live["slideBtn"].get("left", args.slider_left))))
            args.slider_top = int(round(float(live["slideBtn"].get("top", args.slider_top))))
    else:
        g_url = build_g_url(args)
        g_text = http_get(session, g_url, args.cookie)
        g = jsonp_loads(g_text)
        if str(g.get("success")) not in {"1", "True", "true"} and not g.get("bg"):
            raise SystemExit(f"g.html did not return challenge: {g_text[:500]}")
        bg = decode_image(g["bg"], args.cookie)
        patch = decode_image(g["patch"], args.cookie)
        y = int(g.get("y") or 0)
        challenge = g.get("challenge") or g.get("c")
    gap = estimate_gap(bg, patch, y, args.w)
    if args.distance is not None:
        gap["down_distance"] = args.distance
        gap["override_distance"] = True
    points = make_mouse_pos(args.slider_left, args.slider_top, gap["down_distance"])
    d = get_coordinate(points)
    s_url = build_s_url(g_url, args.s_template, challenge, d, args.w, args)
    save_debug(args.out, bg, patch, gap)
    seq_events = []
    real_seq_objects = extract_real_seq_objects(live, args.seq_json)
    if not args.dry_run and real_seq_objects:
        seq_events = send_seq_objects(session, real_seq_objects, cookie=args.cookie, loc=args.loc, rewrite_time=args.rewrite_seq_time)
    elif args.warm_seq and not args.dry_run:
        seq_events = send_seq_warmup(session, cookie=args.cookie, biz_id="passport_jd_com_login_pc", session_id=args.session_id, eid=args.eid, loc=args.loc, username=args.origin, password="x" * args.password_len)

    result = {
        "v_url": f"{API}/slide/v.html?callback={callback()}",
        "g_url": g_url,
        "challenge": challenge,
        "o": (live.get("oElementId") if live else g.get("o")),
        "y": y,
        "gap": gap,
        "mousePos": points,
        "mousePos_first": points[:3],
        "mousePos_last": points[-3:],
        "mousePos_len": len(points),
        "d": d,
        "s_url": s_url,
        "seq_events": seq_events,
    }
    if not args.dry_run:
        s_text = http_get(session, s_url, args.cookie)
        result["s_response_text"] = s_text
        try:
            result["s_response"] = jsonp_loads(s_text)
        except Exception:
            pass
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
