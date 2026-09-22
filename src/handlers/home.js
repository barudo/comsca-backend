class HomeHandler {
  index(_request, response) {
    return response.json({
      success: true,
      message: "On this site will rise the awesome",
    });
  }
}

module.exports = HomeHandler;
