"use strict";
module.exports = {
  apps: [
    {
      name: "api-server",
      script: "./web/backend/server.js",
      watch: false,
    },
    {
      name: "booking-worker",
      script: "./auto/worker.js",
      watch: false,
    },
  ],
};
