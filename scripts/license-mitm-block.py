from mitmproxy import http
def request(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host.endswith("tenuvault.com"):
        flow.response = http.Response.make(403, b"<html><body>Blocked by your organization's web filter.</body></html>", {"Content-Type": "text/html"})
