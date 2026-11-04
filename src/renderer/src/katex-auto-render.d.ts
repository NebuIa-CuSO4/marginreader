declare module 'katex/contrib/auto-render' {
  interface RenderMathInElementOptions {
    delimiters?: Array<{ left: string; right: string; display: boolean }>
    ignoredTags?: string[]
    ignoredClasses?: string[]
    throwOnError?: boolean
    strict?: boolean | 'ignore' | 'warn' | 'error'
    errorColor?: string
    errorCallback?: (message: string, error: Error) => void
    macros?: Record<string, string>
    trust?: boolean | ((context: { command: string; url: string }) => boolean)
  }

  export default function renderMathInElement(
    element: HTMLElement,
    options?: RenderMathInElementOptions
  ): void
}
