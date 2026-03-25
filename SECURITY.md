# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly at mail@andi1984.de
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

You can expect:
- Acknowledgment within 48 hours
- Regular updates on progress
- Credit in the fix announcement (unless you prefer anonymity)

## Security Considerations

When deploying this bot, keep in mind:

### Credentials

- Never commit `.env` files or API keys
- Use environment variables in production
- Rotate API tokens regularly
- Use Supabase service role key only if using RLS

### Mastodon API

- The bot needs `read` and `write` scopes
- Consider using a dedicated bot account
- Monitor for rate limit errors (HTTP 429)

### Database

- Enable Row Level Security (RLS) in Supabase for additional protection
- Regularly review database access logs
- Back up data periodically

### Dependencies

- Run `npm audit` regularly
- Keep dependencies updated
- Review changelogs for security fixes
