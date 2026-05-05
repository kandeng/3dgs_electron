const { app, BrowserWindow, screen, protocol, net } = require('electron');
const path = require('path');

// Register custom scheme BEFORE app is ready so fetch() supports it in the renderer
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
]);

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const win = new BrowserWindow({
    width: Math.round(width * 2 / 3),
    height: Math.round(height * 2 / 3),
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools for debugging (remove in production)
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  // Register custom protocol handler for serving local PLY files securely
  protocol.handle('app', (request) => {
    const url = request.url.replace('app://', '');
    const filePath = path.join(__dirname, url);
    return net.fetch('file://' + filePath);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
