export interface Greeting {
  message: string;
}

export async function fetchGreeting(name?: string, fetchImpl: typeof fetch = fetch): Promise<Greeting> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  const res = await fetchImpl(`/api/greeting${query}`);
  if (!res.ok) throw new Error(`Greeting request failed with ${res.status}`);
  return (await res.json()) as Greeting;
}
