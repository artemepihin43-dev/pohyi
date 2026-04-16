module.exports = {
  apps: [
    {
      name: 'xylivpn-backend',
      script: 'server.js',
      cwd: './backend',
      restart_delay: 3000,
      max_restarts: 10
    },
    {
      name: 'xylivpn-tunnel',
      script: 'tunnel.js',
      cwd: './backend',
      restart_delay: 5000,
      max_restarts: 50
    }
  ]
};
