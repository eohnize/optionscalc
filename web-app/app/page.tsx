import { redirect } from "next/navigation";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export default async function HomePage({ searchParams }: PageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const params = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(resolvedSearchParams)) {
    const value = firstValue(rawValue);
    if (value) {
      params.set(key, value);
    }
  }

  const apiBase = process.env.NEXT_PUBLIC_CALCULATOR_URL;
  if (!params.has("apiBase") && apiBase) {
    params.set("apiBase", trimTrailingSlash(apiBase));
  }

  const query = params.toString();
  redirect(query ? `/options_calculator.html?${query}` : "/options_calculator.html");
}
