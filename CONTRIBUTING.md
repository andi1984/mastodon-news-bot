# Contributing to Mastodon News Bot

Thank you for your interest in contributing! This project welcomes contributions from everyone.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/mastodon-news-bot.git`
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and fill in your credentials
5. Run in development mode: `npm run dev`

## Development Setup

### Prerequisites

- Node.js 20.6.0+
- A Mastodon account with API access (for testing)
- Supabase project (free tier works)
- Claude API key (optional, only needed for AI features)

### Running Tests

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
npm run typecheck     # Type checking only
```

## How to Contribute

### Reporting Bugs

- Check existing issues first to avoid duplicates
- Use the bug report template
- Include steps to reproduce, expected vs actual behavior
- Include relevant logs or error messages

### Suggesting Features

- Use the feature request template
- Explain the use case and why it would be valuable
- Consider how it fits with the project's goals

### Pull Requests

1. Create a branch from `master`: `git checkout -b feature/your-feature`
2. Make your changes
3. Run tests: `npm test`
4. Run type checking: `npm run typecheck`
5. Format code: `npx prettier --write .`
6. Commit with a clear message
7. Push and open a PR

### Code Style

- TypeScript strict mode
- ESM modules (use `.js` extensions in imports)
- Prettier for formatting (config in `.prettierrc`)
- Clear, descriptive variable and function names
- Add comments for complex logic

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). All commits must follow this format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

**Allowed types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, etc.) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependencies |
| `ci` | CI configuration |
| `chore` | Other changes that don't modify src or test files |
| `revert` | Reverts a previous commit |

**Examples:**

```bash
feat: add webhook notifications for breaking news
fix(rss): handle malformed feed entries gracefully
docs: update database setup instructions
refactor(similarity): extract token matching to separate function
feat!: change API response format  # Breaking change
```

**Enforcement:**

- **Local:** A pre-commit hook validates your commit messages using commitlint
- **CI:** Pull requests are checked to ensure all commits follow the convention
- **Releases:** Version numbers are automatically calculated from commit types:
  - `feat` = minor version bump (1.0.0 → 1.1.0)
  - `fix` and others = patch version bump (1.0.0 → 1.0.1)
  - `!` or `BREAKING CHANGE` = major version bump (1.0.0 → 2.0.0)

## Project Structure

```
src/
├── index.ts              # Main entry, Bree job scheduler
├── jobs/                 # Scheduled jobs (cron/interval)
├── helper/               # Shared utilities
├── scripts/              # Manual CLI scripts
└── data/settings.json    # Configuration
```

## Areas for Contribution

- **New feed sources** - Add support for different RSS formats
- **Language support** - Improve internationalization (stopwords, prompts)
- **Documentation** - Improve setup guides, add examples
- **Testing** - Increase test coverage
- **Performance** - Optimize matching algorithms
- **Features** - Implement items from the issue tracker

## Questions?

Feel free to open an issue for questions about contributing.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
