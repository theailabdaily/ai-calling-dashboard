import { redirect } from 'next/navigation';

// Auth removed — /login now just redirects to home.
export default function LoginPage() {
  redirect('/');
}
