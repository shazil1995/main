import { NextRequest, NextResponse } from "next/server";

// Lightweight UX guard only: the "sid" cookie is httpOnly, so middleware can
// see it exists but cannot read its value. Real authorization always happens
// server-side in the API (SessionAuthGuard); this just avoids flashing the
// dashboard before an inevitable redirect.
export function middleware(request: NextRequest) {
  const hasSession = request.cookies.has("sid");
  if (!hasSession) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
