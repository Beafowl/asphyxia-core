import SysTray from 'systray';
import { ReadAssets } from './EamuseIO';
import opn from 'open';
import { VERSION } from './Consts';

export function CreateTray() {
  if (process.platform === 'win32') {
    const systray = new SysTray({
      menu: {
        // you should using .png icon in macOS/Linux, but .ico format in windows
        icon: ReadAssets('icon.b64'),
        title: 'Asphyxia CORE',
        tooltip: `Asphyxia CORE ${VERSION}`,
        items: [
          {
            title: 'Config',
            tooltip: 'Open WebUI',
            checked: false,
            enabled: true,
          },
          {
            title: 'Exit',
            tooltip: 'Exit CORE',
            checked: false,
            enabled: true,
          },
        ],
      },
      debug: false,
      copyDir: true,
    });

    systray.onClick(action => {
      if (action.seq_id === 0) {
        opn('http://localhost:8083');
      } else if (action.seq_id === 1) {
        systray.kill();
        systray.writeLine;
      }
    });
  }
}
