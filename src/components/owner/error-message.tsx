export function ErrorMessage({ children }: { children: string }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-5 text-red-700" role="alert">
      {children}
    </p>
  )
}
