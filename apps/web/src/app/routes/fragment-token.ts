import { useEffect, useState } from "react";
import { takeFragmentToken } from "../../lib/api/onboarding";

/**
 * For the pages whose link carries a token in the URL fragment (Identity §2, Platform §10): reads the
 * token once, strips the fragment with `history.replaceState`, and adds `<meta name="referrer"
 * content="no-referrer">` while the page is open, on top of the `Referrer-Policy: no-referrer` header
 * the page is served with. Opening the page changes nothing on the server; only its POST does.
 */
export function useFragmentToken(): string | null {
  const [token] = useState(takeFragmentToken);
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  return token;
}
