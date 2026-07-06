#!/usr/bin/env python3
"""Live scenario harness: mimics distinct shoppers against the production
App Proxy (saleshq-2), seeds real event sequences, and asks the proactive
engine (debug mode) what it decides. Prints one JSON result per scenario."""
import json, time, urllib.request, http.cookiejar, uuid
from datetime import datetime, timedelta, timezone

BASE = "https://saleshq-2.myshopify.com"
PW = "password"

# Real products (from /products.json)
LIQUID   = "gid://shopify/Product/9364341162215"  # 749.95 in stock
OXYGEN   = "gid://shopify/Product/9364341031143"  # 1025 in stock
HYDROGEN = "gid://shopify/Product/9364340768999"  # 600 in stock
MULTI    = "gid://shopify/Product/9364341129447"  # 629.95 in stock
COMPLETE = "gid://shopify/Product/9364340834535"  # 699.95 OOS now

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def req(path, data=None, ctype="text/plain"):
    url = BASE + path
    d = data.encode() if isinstance(data, str) else data
    r = urllib.request.Request(url, data=d, headers={"Content-Type": ctype} if d else {})
    try:
        with op.open(r, timeout=120) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# unlock storefront password
req("/password")
req("/password", "form_type=storefront_password&utf8=%E2%9C%93&password=" + PW,
    "application/x-www-form-urlencoded")

def iso(sec_ago):
    return (datetime.now(timezone.utc) - timedelta(seconds=sec_ago)).isoformat().replace("+00:00", "Z")

def ingest(sid, typ, sec_ago, **extra):
    ev = {"eventId": f"{typ}_{sid}_{uuid.uuid4().hex[:8]}", "shopId": "x", "sessionId": sid,
          "type": typ, "timestamp": iso(sec_ago), "source": "pixel", **extra}
    s, b = req("/apps/saleshq/ingest", json.dumps(ev))
    assert s == 200, f"ingest {s} {b[:200]}"

def proactive(sid, **body):
    s, b = req("/apps/saleshq/proactive", json.dumps({"sessionId": sid, "debug": True, **body}))
    try: j = json.loads(b)
    except Exception: j = {"raw": b[:300]}
    return s, j

def chat(sid, msg):
    s, b = req("/apps/saleshq/chat", json.dumps({"sessionId": sid, "message": msg, "history": []}))
    try: return s, json.loads(b)
    except Exception: return s, {"raw": b[:300]}

def out(name, status, j, note=""):
    d = j.get("_debug") or {}
    print(json.dumps({
        "scenario": name, "http": status, "show": j.get("show"),
        "trigger": d.get("triggerReason"), "gates": d.get("gates"),
        "intent": d.get("intent"), "response": (j.get("response") or "")[:180],
        "n_products": len(j.get("products") or []), "followups": j.get("followups"),
        "composeError": d.get("composeError"), "note": note,
    }))

RUN = int(time.time())
S = lambda n: f"sid_sc{RUN}_{n}"

# ---- 1. product_dwell — "lingerer" persona: single PDP, long dwell
sid = S("dwell")
ingest(sid, "product_view", 40, productId=LIQUID, category="snowboard", price=749.95, surface="product")
ingest(sid, "page_view", 5, productId=LIQUID, surface="product", dwellMs=12000)
s, j = proactive(sid, productId=LIQUID, surface="product")
out("product_dwell (lingerer)", s, j)
dwell_sid = sid

# ---- 2. product_compare — "budget comparer": pdp loop >= 2 across 600-750 boards
sid = S("compare")
seq = [(HYDROGEN, 600), (MULTI, 629.95), (HYDROGEN, 600), (LIQUID, 749.95), (MULTI, 629.95)]
for i, (pid, price) in enumerate(seq):
    ingest(sid, "product_view", 90 - i * 15, productId=pid, category="snowboard", price=price, surface="product")
ingest(sid, "search", 12, searchTerm="snowboard under 700", surface="search")
s, j = proactive(sid, productId=MULTI, surface="product")
out("product_compare (budget comparer)", s, j)
compare_sid = sid

# ---- 3. browse_no_addtocart — "category scroller": collection + scroll thrash
sid = S("browse")
ingest(sid, "collection_view", 50, category="snowboard", surface="category")
ingest(sid, "product_view", 35, productId=OXYGEN, category="snowboard", price=1025, surface="product")
ingest(sid, "collection_view", 12, category="snowboard", surface="category", scrollThrash=4)
s, j = proactive(sid, surface="category")
out("browse_no_addtocart (scroller)", s, j)

# ---- 4. search_refinement — "refiner": repeated searches + thrash
sid = S("search")
ingest(sid, "search", 45, searchTerm="snowboard", surface="search")
ingest(sid, "search", 25, searchTerm="cheap snowboard", surface="search")
ingest(sid, "search", 10, searchTerm="snowboard under 700", surface="search", scrollThrash=3)
s, j = proactive(sid, surface="search")
out("search_refinement (refiner)", s, j)

# ---- 5. cart_idle — "hesitant carter": add to cart then idle on cart page
sid = S("cart")
ingest(sid, "product_view", 80, productId=HYDROGEN, category="snowboard", price=600, surface="product")
ingest(sid, "add_to_cart", 60, productId=HYDROGEN, price=600, surface="product")
ingest(sid, "page_view", 8, surface="cart", cartIdleMs=27000)
s, j = proactive(sid, surface="cart")
out("cart_idle (hesitant carter)", s, j)

# ---- 6. exit_intent — "abandoner": browsing then mouse-out
sid = S("exit")
ingest(sid, "product_view", 30, productId=OXYGEN, category="snowboard", price=1025, surface="product")
ingest(sid, "exit_intent", 2, surface="product")
s, j = proactive(sid, productId=OXYGEN, surface="product", exitIntent=True)
out("exit_intent (abandoner)", s, j)

# ---- 7. NEGATIVE idle bounce: one view, no friction -> silent
sid = S("idle")
ingest(sid, "product_view", 20, productId=LIQUID, category="snowboard", price=749.95, surface="product")
s, j = proactive(sid, productId=LIQUID, surface="product")
out("NEG idle bounce", s, j, "expect show:false, signal none")

# ---- 8. NEGATIVE smooth buyer: dwell present but add_to_cart => smooth >= 0.7
sid = S("smooth")
ingest(sid, "product_view", 40, productId=MULTI, category="snowboard", price=629.95, surface="product")
ingest(sid, "add_to_cart", 25, productId=MULTI, price=629.95, surface="product")
ingest(sid, "page_view", 5, productId=MULTI, surface="product", dwellMs=15000)
s, j = proactive(sid, productId=MULTI, surface="product")
out("NEG smooth buyer", s, j, "expect suppressed (smooth progression)")

# ---- 9. NEGATIVE too-new session (< 8s)
sid = S("new")
ingest(sid, "product_view", 2, productId=LIQUID, surface="product", dwellMs=12000)
s, j = proactive(sid, productId=LIQUID, surface="product")
out("NEG session <8s", s, j, "expect eligibility fail")

# ---- 10. NEGATIVE widget already open
sid = S("wopen")
ingest(sid, "product_view", 30, productId=LIQUID, category="snowboard", price=749.95, surface="product", dwellMs=12000)
s, j = proactive(sid, productId=LIQUID, surface="product", widgetOpen=True)
out("NEG widget open", s, j, "expect eligibility fail")

# ---- 11. same-reason cooldown: dwell session asks again immediately
s, j = proactive(dwell_sid, productId=LIQUID, surface="product")
out("NEG repeat same trigger (5min cooldown)", s, j, "expect show:false")

# ---- 12. dismissal silences session
sid = S("dismiss")
ingest(sid, "product_view", 40, productId=LIQUID, category="snowboard", price=749.95, surface="product", dwellMs=12000)
req("/apps/saleshq/dismiss", json.dumps({"sessionId": sid}))
time.sleep(1)
s, j = proactive(sid, productId=LIQUID, surface="product")
out("NEG dismissed session", s, j, "expect eligibility fail")

# ---- 13. multi-pop same session, different reason (dwell already shown -> now compare)
ingest(dwell_sid, "product_view", 6, productId=HYDROGEN, category="snowboard", price=600, surface="product")
ingest(dwell_sid, "product_view", 4, productId=LIQUID, category="snowboard", price=749.95, surface="product")
ingest(dwell_sid, "product_view", 2, productId=HYDROGEN, category="snowboard", price=600, surface="product")
ingest(dwell_sid, "product_view", 1, productId=LIQUID, category="snowboard", price=749.95, surface="product")
time.sleep(1)
s, j = proactive(dwell_sid, productId=LIQUID, surface="product")
out("second nudge same session (compare after dwell)", s, j, "expect show:true product_compare")

# ---- 14. intent personalization via chat (budget comparer persona)
s, j = chat(compare_sid, "which snowboard should I get?")
print(json.dumps({"scenario": "chat personalization (budget comparer)", "http": s,
                  "response": (j.get("response") or "")[:280],
                  "products": [(p.get("title"), p.get("price"), p.get("badge")) for p in (j.get("products") or [])][:5]}))
