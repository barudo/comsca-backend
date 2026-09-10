function groupSlugMiddleware(db) {
  return async (request, response, next) => {
    const groupSlug = request.get("x-group-slug")?.trim();

    if (!groupSlug) {
      return response.status(400).json({
        success: false,
        error: "x-group-slug header is required",
      });
    }

    try {
      const group = await db("groups").where({ slug: groupSlug }).first();

      if (!group) {
        return response.status(404).json({
          success: false,
          error: "Group not found",
        });
      }

      request.group = group;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = groupSlugMiddleware;
