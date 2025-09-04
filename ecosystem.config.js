module.exports = {
  apps: [{
    name: "sri-service",
    script: "dist/server.js",
    instances: process.env.NODE_ENV === 'production' ? "max" : 1,
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
      PORT: 8090
    },
    env_production: {
      NODE_ENV: "production",
      PORT: 8090
    },
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    log_file: "./logs/combined.log",
    time: true,
    max_memory_restart: "1G",
    listen_timeout: 5000,
    kill_timeout: 5000
  }]
};