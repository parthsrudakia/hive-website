function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  // Remember where the admin was headed (e.g. a permanent photo-ID link from a
  // notification email) so login can send them straight back there.
  if (req.session && req.method === 'GET' && req.get('X-Requested-With') !== 'fetch') {
    req.session.returnTo = req.originalUrl;
  }
  res.redirect('/admin/login');
}

// Only ever bounce back to a local admin page (never an external URL).
function safeReturnTo(value) {
  return typeof value === 'string' && /^\/admin\/(?!login|logout)[^\s\\]*$/.test(value) && !value.includes('//')
    ? value
    : null;
}

module.exports = { requireAdmin, safeReturnTo };
