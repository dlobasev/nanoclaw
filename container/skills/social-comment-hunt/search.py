#!/usr/bin/env python3
"""Search LinkedIn, Reddit, and X for fresh GEO/AI visibility posts.

Outputs a JSON array to stdout. All diagnostics go to stderr.
The agent calls this script and uses the output to write comments.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta

LOG_PATH = "/workspace/group/projects/reachd/geo_posts_log.txt"
MAX_AGE_HOURS = 48
POSTS_PER_SOURCE = 3
CURL_TIMEOUT = 15
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

LINKEDIN_QUERIES = [
    'site:linkedin.com/posts "AI visibility" OR "GEO optimization"',
    'site:linkedin.com/posts "AI search" brand visibility OR recommendation',
]

REDDIT_QUERIES = [
    'site:reddit.com "AI visibility" OR "GEO optimization"',
    'site:reddit.com "AI search" brand visibility OR recommendation',
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_seen_urls() -> set:
    """Load previously seen URLs from the dedup log."""
    try:
        with open(LOG_PATH) as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()


def classify_platform(url: str) -> str:
    if "linkedin.com" in url:
        return "linkedin"
    if "reddit.com" in url:
        return "reddit"
    if "x.com" in url or "twitter.com" in url:
        return "x"
    return "other"


def is_real_post(url: str, platform: str) -> bool:
    """Filter out blog articles, press releases, news sites."""
    if platform == "linkedin":
        if "/posts/" in url or "/feed/update/" in url:
            return True
        return False
    if platform == "reddit":
        if "/r/" in url and "/comments/" in url:
            return True
        return False
    return True


def parse_relative_date(date_str: str) -> datetime | None:
    """Parse SerpAPI relative dates like '2 hours ago', '1 day ago'."""
    if not date_str:
        return None
    now = datetime.now()
    m = re.search(r"(\d+)\s+(minute|hour|day|week|month)s?\s+ago", date_str, re.I)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        deltas = {
            "minute": timedelta(minutes=n),
            "hour": timedelta(hours=n),
            "day": timedelta(days=n),
            "week": timedelta(weeks=n),
            "month": timedelta(days=n * 30),
        }
        return now - deltas.get(unit, timedelta())

    # Try common absolute formats
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None


def is_fresh(date_str: str) -> bool:
    """Check if a post is within MAX_AGE_HOURS."""
    parsed = parse_relative_date(date_str)
    if parsed is None:
        # Can't determine date — reject to avoid old posts
        return False
    cutoff = datetime.now() - timedelta(hours=MAX_AGE_HOURS)
    return parsed >= cutoff


def search_serpapi(queries: list, seen: set) -> list:
    """Search via SerpAPI with explicit date range."""
    try:
        from serpapi import GoogleSearch
    except ImportError:
        log("ERROR: serpapi not installed")
        return []

    api_key = os.environ.get("SERPAPI_API_KEY")
    if not api_key:
        log("ERROR: SERPAPI_API_KEY not set")
        return []

    now = datetime.now()
    yesterday = now - timedelta(days=1)
    tbs = f"cdr:1,cd_min:{yesterday.strftime('%m/%d/%Y')},cd_max:{now.strftime('%m/%d/%Y')}"

    posts = []
    seen_urls = set(seen)

    for query in queries:
        try:
            log(f"SerpAPI: {query}")
            results = GoogleSearch({
                "q": query,
                "api_key": api_key,
                "num": 10,
                "tbs": tbs,
                "sort": "date",
            }).get_dict()

            for r in results.get("organic_results", []):
                url = r.get("link", "")
                if not url or url in seen_urls:
                    continue

                platform = classify_platform(url)
                if not is_real_post(url, platform):
                    continue

                date_str = r.get("date", "")
                if date_str and not is_fresh(date_str):
                    log(f"  SKIP (old): {date_str} — {url}")
                    continue

                seen_urls.add(url)
                posts.append({
                    "platform": platform,
                    "author": "",
                    "url": url,
                    "title": r.get("title", ""),
                    "snippet": r.get("snippet", ""),
                    "full_text": "",
                    "date": date_str,
                })
        except Exception as e:
            log(f"  SerpAPI error: {e}")

    return posts


def search_x(seen: set) -> list:
    """Search X via xAI Responses API with x_search tool."""
    api_key = os.environ.get("XAI_API_KEY")
    if not api_key:
        log("ERROR: XAI_API_KEY not set")
        return []

    now = datetime.now()
    yesterday = now - timedelta(days=1)
    from_date = yesterday.strftime("%Y-%m-%d")
    to_date = now.strftime("%Y-%m-%d")

    prompt = (
        f"Search X for posts published ONLY between {from_date} and {to_date}. "
        "Topic: GEO optimization, AI visibility for businesses, or how brands appear "
        "in ChatGPT/Perplexity/AI search. "
        "Return 5 posts with highest engagement. "
        "For each post return a JSON object with fields: author, text, url, date. "
        f"STRICT: reject any post older than {from_date}. "
        "Only real posts with engagement, skip news bots and spam. "
        "Return ONLY a JSON array, no other text."
    )

    body = json.dumps({
        "model": "grok-4-1-fast-reasoning",
        "input": [{"role": "user", "content": prompt}],
        "tools": [{"type": "x_search", "from_date": from_date, "to_date": to_date}],
    })

    try:
        log("xAI: searching X")
        req = urllib.request.Request(
            "https://api.x.ai/v1/responses",
            data=body.encode(),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())

        # Navigate to the text output
        output = data.get("output", [])
        text = ""
        for item in reversed(output):
            if item.get("type") == "message":
                for block in item.get("content", []):
                    if block.get("type") == "output_text":
                        text = block.get("text", "")
                        break
                if text:
                    break

        if not text:
            log("  xAI: no text in response")
            return []

        # Try structured JSON first, fall back to URL extraction
        posts = _parse_x_json(text, seen)
        if not posts:
            posts = _parse_x_urls(text, seen)
        return posts

    except Exception as e:
        log(f"  xAI error: {e}")
        return []


def _parse_x_json(text: str, seen: set) -> list:
    """Parse JSON array of posts from xAI response text."""
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        return []

    try:
        items = json.loads(match.group())
    except json.JSONDecodeError:
        return []

    posts = []
    for item in items:
        url = item.get("url", "")
        if not url or url in seen:
            continue
        posts.append({
            "platform": "x",
            "author": item.get("author", ""),
            "url": url,
            "title": "",
            "snippet": "",
            "full_text": item.get("text", ""),
            "date": item.get("date", ""),
        })
    return posts


def _parse_x_urls(text: str, seen: set) -> list:
    """Fallback: extract x.com URLs from prose response."""
    urls = re.findall(r"https?://(?:x\.com|twitter\.com)/\S+", text)
    posts = []
    for url in urls:
        url = url.rstrip(")")
        if url in seen:
            continue
        posts.append({
            "platform": "x",
            "author": "",
            "url": url,
            "title": "",
            "snippet": "",
            "full_text": text[:2000],
            "date": "",
        })
    return posts


def fetch_full_text(url: str) -> str:
    """Fetch and extract text from a web page via curl."""
    try:
        result = subprocess.run(
            [
                "curl", "-sL", f"-m{CURL_TIMEOUT}",
                "-H", f"User-Agent: {USER_AGENT}",
                "-H", "Accept: text/html,application/xhtml+xml",
                "-H", "Accept-Language: en-US,en;q=0.9",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=CURL_TIMEOUT + 5,
        )
        html = result.stdout
        if not html:
            return ""

        # Strip scripts and styles
        text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:4000]
    except Exception as e:
        log(f"  curl failed for {url}: {e}")
        return ""


def rank_and_trim(posts: list) -> dict:
    """Group by platform, trim to POSTS_PER_SOURCE each."""
    by_platform = {}
    for post in posts:
        p = post["platform"]
        by_platform.setdefault(p, []).append(post)

    result = {}
    for platform, items in by_platform.items():
        result[platform] = items[:POSTS_PER_SOURCE]

    return result


def update_log(posts: list) -> None:
    """Append found URLs to the dedup log."""
    if not posts:
        return
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a") as f:
        for post in posts:
            f.write(post["url"] + "\n")


def main() -> None:
    seen = load_seen_urls()

    linkedin_posts = search_serpapi(LINKEDIN_QUERIES, seen)
    log(f"LinkedIn: found {len(linkedin_posts)} posts")

    # Update seen to avoid cross-source duplicates
    for p in linkedin_posts:
        seen.add(p["url"])

    reddit_posts = search_serpapi(REDDIT_QUERIES, seen)
    log(f"Reddit: found {len(reddit_posts)} posts")

    for p in reddit_posts:
        seen.add(p["url"])

    x_posts = search_x(seen)
    log(f"X: found {len(x_posts)} posts")

    all_posts = linkedin_posts + reddit_posts + x_posts

    # Fetch full text for LinkedIn and Reddit (X already has it from xAI)
    for post in all_posts:
        if post["platform"] in ("linkedin", "reddit") and not post["full_text"]:
            log(f"  Fetching: {post['url']}")
            post["full_text"] = fetch_full_text(post["url"])

    ranked = rank_and_trim(all_posts)

    flat = []
    for platform_posts in ranked.values():
        flat.extend(platform_posts)

    log(f"Total: {len(flat)} posts")
    print(json.dumps(flat, ensure_ascii=False, indent=2))

    update_log(flat)


if __name__ == "__main__":
    main()
