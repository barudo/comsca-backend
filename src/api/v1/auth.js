const express = require("express");

const router = express.Router();

router.get("/", (_request, response) => {
  response.json({
    success: true,
    message: "Authentication endpoint",
  });
});

router.post("/login", (_request, response) => {
  response.status(501).json({
    success: false,
    error: "Login is not implemented",
  });
});

module.exports = router;
