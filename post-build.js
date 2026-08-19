const fs = require('fs');
const path = require('path');

const platform = process.argv[2]; // 'win32' or 'linux'
const distDir = path.join(__dirname, 'dist');

if (platform === 'win32') {
  const winDir = path.join(distDir, 'SimpleAntrian-win32-x64');
  if (fs.existsSync(winDir)) {
    fs.writeFileSync(path.join(winDir, 'Mulai-Server.bat'), '@echo off\r\nstart "" "%~dp0SimpleAntrian.exe" --server\r\n');
    fs.writeFileSync(path.join(winDir, 'Mulai-Client.bat'), '@echo off\r\nstart "" "%~dp0SimpleAntrian.exe" --client\r\n');
    console.log('[Post-Build] Created Mulai-Server.bat and Mulai-Client.bat in dist/SimpleAntrian-win32-x64');
  } else {
    console.error('[Post-Build] Directory dist/SimpleAntrian-win32-x64 does not exist.');
  }
} else if (platform === 'linux') {
  const linuxDir = path.join(distDir, 'SimpleAntrian-linux-x64');
  if (fs.existsSync(linuxDir)) {
    const serverSh = '#!/bin/bash\ndescription="Mulai Server"\ndirname="$(dirname "$0")"\n"$dirname/SimpleAntrian" --server &\n';
    const clientSh = '#!/bin/bash\ndescription="Mulai Client"\ndirname="$(dirname "$0")"\n"$dirname/SimpleAntrian" --client &\n';
    
    fs.writeFileSync(path.join(linuxDir, 'mulai-server.sh'), serverSh);
    fs.writeFileSync(path.join(linuxDir, 'mulai-client.sh'), clientSh);
    
    try {
      fs.chmodSync(path.join(linuxDir, 'mulai-server.sh'), '755');
      fs.chmodSync(path.join(linuxDir, 'mulai-client.sh'), '755');
    } catch (_) {}
    console.log('[Post-Build] Created mulai-server.sh and mulai-client.sh in dist/SimpleAntrian-linux-x64');
  } else {
    console.error('[Post-Build] Directory dist/SimpleAntrian-linux-x64 does not exist.');
  }
}
