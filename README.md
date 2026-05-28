# Infiniti IA DJ Lab

Web app de mezcla DJ para escritorio, creada como laboratorio gratuito para estudiantes. Usa archivos locales del usuario, analiza BPM/kicks en el navegador y dibuja waveforms con grilla de beats.

## Ejecutar

```powershell
npm start
```

Luego abre:

```text
http://127.0.0.1:5173
```

## Deploy en Vercel

La app esta lista para deploy estatico desde GitHub.

- Framework Preset: `Other`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `dist`
- Environment Variables: ninguna
- API Keys: ninguna

Vercel solo sirve los archivos estaticos. El analisis de audio, la lectura de carpetas y la mezcla ocurren en el navegador del usuario.

## Funciones

- Abrir una carpeta local con `showDirectoryPicker` en navegadores compatibles.
- Fallback para subir canciones o carpetas con input de archivos.
- Dos decks con play/pause, stop, cue, set cue, tempo, gain y EQ.
- SYNC iguala BPM efectivo con precision decimal y ajusta la fase para alinear los kicks entre decks.
- Editor manual de beat grid por deck: mover la grilla, fijar primer beat desde el playhead, ajustar BPM en 0.01 y restaurar el analisis.
- Doble click en las luces de Beat Match hace una correccion fina para centrar la fase en 0%.
- Doble click en Low, Mid o High devuelve el EQ del deck a 0 dB.
- Crossfader, master gain, medidor master y comparador de fase.
- Analisis local de waveform, BPM, beat grid y marcadores de kicks.
- Demo beat sintetico de 128 BPM para probar sin archivos externos.
- Bloqueo visual para moviles: la cabina esta disenada solo para computadora.

## Notas tecnicas

El navegador no permite leer carpetas sin accion del usuario. Por eso la app pide seleccionar la carpeta desde un boton y procesa todo localmente con Web Audio API; no sube musica a ningun servidor.
