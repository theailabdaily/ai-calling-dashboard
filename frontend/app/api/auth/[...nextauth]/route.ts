// Auth removed. NextAuth endpoints are no longer active.
import { NextResponse } from 'next/server';
export function GET() { return NextResponse.json({ error: 'auth disabled' }, { status: 404 }); }
export function POST() { return NextResponse.json({ error: 'auth disabled' }, { status: 404 }); }
