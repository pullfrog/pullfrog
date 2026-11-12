import { getApiUrl } from "./apiUrl.ts";
import { log } from "./cli.ts";
import { vercelBypassSecretFor } from "./vercelBypass.ts";

type ApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * fetch wrapper for hitting the Pullfrog API with Vercel deployment protection bypass.
 *
 * the bypass secret goes in a header, never the query: Vercel's request log records the
 * full URL, so a query parameter lands the secret in Better Stack.
 */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const apiUrl = getApiUrl();
  const url = new URL(options.path, apiUrl);

  const headers: Record<string, string> = {
    ...options.headers,
  };

  const bypassSecret = vercelBypassSecretFor(url);
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  // never send Content-Type on body-less requests. empirically, Vercel's
  // Next.js lambda adapter (Next 16.1.x) throws `SyntaxError: Unexpected
  // end of data` before delegating to the route handler — returning a 500 —
  // when Content-Type is set but no body is present. exact mechanism is
  // unverified (minified runtime frame), but Content-Type on a body-less
  // request has no defined semantics per RFC 9110 §8.3 anyway. see #692.
  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  log.debug(`api fetch: ${options.method ?? "GET"} ${url.pathname}`);

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  return fetch(url.toString(), init);
}
