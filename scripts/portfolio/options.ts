export interface PortfolioOptions {
  headless: boolean;
  smoke: boolean;
  noOpen: boolean;
}

export class PortfolioError extends Error {
  constructor(
    readonly code:
      | 'PORTFOLIO_ARGUMENTS_INVALID'
      | 'PORTFOLIO_BROWSER_NOT_INSTALLED'
      | 'PORTFOLIO_BROWSER_LAUNCH_FAILED'
      | 'PORTFOLIO_BROWSER_START_FAILED'
      | 'PORTFOLIO_AUTHENTICATION_INVALID',
  ) {
    super(code);
  }
}

export function portfolioOptions(arguments_: string[]): PortfolioOptions {
  const flags = new Set(arguments_);
  if (
    flags.size !== arguments_.length ||
    arguments_.some((flag) => !['--headless', '--smoke', '--no-open'].includes(flag)) ||
    flags.has('--smoke') !== flags.has('--headless') ||
    (flags.has('--no-open') && (flags.has('--smoke') || flags.has('--headless')))
  )
    throw new PortfolioError('PORTFOLIO_ARGUMENTS_INVALID');
  return {
    headless: flags.has('--headless'),
    smoke: flags.has('--smoke'),
    noOpen: flags.has('--no-open'),
  };
}
