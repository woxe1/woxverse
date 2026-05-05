# Woxverse Desktop

Electron desktop shell for the React app in `../react-ts-app`.

## Development

```bash
cd electron-desktop-app
npm install
npm run dev
```

This starts:
- the Vite dev server from `../react-ts-app`
- the Electron window pointing to that dev server

## Windows build

```bash
cd electron-desktop-app
npm install
npm run build:win
```

That will:
- build the React app
- package the Electron shell
- create Windows installer artifacts in `electron-desktop-app/dist`

## Notes

- The desktop app loads the packaged React build from `../react-ts-app/dist` in production.
- Your FastAPI backend still needs to be running separately if the UI depends on it.
