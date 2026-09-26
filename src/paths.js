import path from 'node:path';
import { userInfo } from 'node:os';

export function userPaths(home = userInfo().homedir) {
  const root = path.join(home, '.xfx');
  return {
    root,
    app: path.join(root, 'app'),
    controller: path.join(root, 'controller'),
    profiles: path.join(root, 'profiles'),
    ramlogs: path.join(root, 'ramlogs'),
    bin: path.join(home, '.local', 'bin', 'xfx'),
    launchAgent: path.join(home, 'Library', 'LaunchAgents', 'com.xenoflux.ramlogs.plist'),
  };
}
