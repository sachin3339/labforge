import { redirect } from 'next/navigation';
import { getApiKey } from '@/lib/api';

export default async function Home() {
  const key = await getApiKey();
  redirect(key ? '/dashboard' : '/login');
}
