/**
 * asyncHandler — সব async route handler wrap করে error catch করে
 *
 * ব্যবহার: router.get("/", asyncHandler(async (req, res) => { ... }));
 * unhandled rejection হলে Express error handler-এ পাঠায়
 */
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
