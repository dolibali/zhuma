/** Desktop-only transport state. The Host remains the sole member/session authority. */
const MEMBER = 'zhuma-member';
const APP_ORIGIN = 'dsh-app://app';
const MEMBER_PATH =
  /^\/(?:zhuma-id\/(?:login|logout|session|(?:spaces|notes)\/[a-z0-9-]{1,64})|api\/zhuma-member\/(?:snapshot|command|plan|asset-list|asset-read|asset-reference|asset-command|asset-sources|asset-source|asset-catalog|asset-file-upload|asset-file-read|asset-file-text)|api\/zhuma-exec\/(?:start-plan|inbox-counts|inbox|startable|submit|ballot|settle|report|revision|review-outcome|draft|events|upstream-content|project-artifacts|task-progress|upload-file|file)|api\/zhuma-run\/(?:begin|send|stop|read|history|options|inbox|observe)|api\/zhuma-workflow\/(?:options|read|start|resume|stop)|api\/zhuma-knowledge\/(?:libraries|list|search|read|drafts|draft|save-draft|propose-draft|publish|project-links|save-project-links))$/;
const MAX_AGE_SECONDS = 12 * 60 * 60;

function rejected(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** Accept only the current Host's narrow member-cookie transport format, not a general jar. */
function loginCookie(headers: Headers): { value: string; maxAge: number } | undefined {
  const candidates = headers.getSetCookie().filter((line) => line.startsWith(`${MEMBER}=`));
  if (candidates.length !== 1) return undefined;
  const [pair, ...attributes] = candidates[0]!.split(';');
  const value = pair!.slice(MEMBER.length + 1);
  if (!/^[A-Za-z0-9._-]{1,4096}$/.test(value)) return undefined;
  const attrs = new Map<string, string>();
  for (const raw of attributes) {
    const [key, ...rest] = raw.trim().split('=');
    const name = key!.toLowerCase();
    if (attrs.has(name)) return undefined;
    attrs.set(name, rest.join('='));
  }
  const age = attrs.get('max-age');
  if (
    attrs.size !== 4 ||
    attrs.get('path') !== '/' ||
    attrs.get('httponly') !== '' ||
    attrs.get('samesite')?.toLowerCase() !== 'strict' ||
    !age ||
    !/^[0-9]+$/.test(age)
  )
    return undefined;
  const maxAge = Number(age);
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 || maxAge > MAX_AGE_SECONDS) return undefined;
  return { value, maxAge };
}

/**
 * One owned desktop Host, one opaque member cookie in main-process memory.
 * No renderer cookie input, disk, authorization decisions, retry or automatic owner-to-member mapping.
 * `dispatch` is the existing authenticated forwarding operation; its credential never leaves main.
 */
export function createDesktopMemberCookieBridge(now: () => number = Date.now) {
  let hostOrigin: string | undefined;
  let owner: string | undefined;
  let member: { value: string; expiresAt: number } | undefined;
  let epoch = 0;
  function clear() {
    member = undefined;
    ++epoch;
  }
  return {
    clear,
    async forward(
      request: Request,
      host: string,
      ownerCookie: string,
      dispatch: (cookieHeader: string) => Promise<Response>,
    ): Promise<Response> {
      const source = new URL(request.url);
      const origin = request.headers.get('origin');
      if (
        source.protocol !== 'dsh-app:' ||
        source.host !== 'app' ||
        source.username ||
        source.password ||
        (origin !== null && origin !== APP_ORIGIN) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        return rejected(403);
      if (request.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
      const target = new URL(host);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) ||
        target.username ||
        target.password ||
        !ownerCookie ||
        /[\r\n;]/.test(ownerCookie)
      )
        return rejected(503);
      if (hostOrigin !== target.origin || owner !== ownerCookie) {
        clear();
        hostOrigin = target.origin;
        owner = ownerCookie;
      }
      if (member && member.expiresAt <= now()) clear();
      const product = MEMBER_PATH.test(source.pathname);
      const login = product && request.method === 'POST' && source.pathname === '/zhuma-id/login';
      const logout = product && request.method === 'POST' && source.pathname === '/zhuma-id/logout';
      // Logout revokes the previous Host session, so capture that credential before clearing locally.
      const credential = member;
      if (login || logout) clear();
      const current = epoch;
      const carried = !login && product ? credential : undefined;
      // Even a legacy-configured Host must never receive an owner-only product operation.
      if (product && !login && !carried) return rejected(401);
      const response = await dispatch(
        carried ? `${ownerCookie}; ${MEMBER}=${carried.value}` : ownerCookie,
      );
      if (request.signal.aborted || (product && current !== epoch)) {
        await response.body?.cancel();
        if (request.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
        return rejected(401);
      }
      if (product && response.status === 401) clear();
      if (login && response.status === 200) {
        const accepted = loginCookie(response.headers);
        if (!accepted) {
          await response.body?.cancel();
          return rejected(502);
        }
        member = { value: accepted.value, expiresAt: now() + accepted.maxAge * 1000 };
      }
      const headers = new Headers(response.headers);
      headers.delete('set-cookie');
      if (product) headers.set('cache-control', 'no-store');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
