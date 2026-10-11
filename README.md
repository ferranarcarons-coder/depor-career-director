# Dépor Career Director

Web app per gestionar una Career Mode realista amb el Deportivo de La Coruña a EA Sports FC27.

## Arrencada

```bash
npm start
```

El servei exposa:

- `/` — aplicació web
- `/health` — comprovació d'estat
- `/api/players/search?q=...` — cerca de jugadors
- `/api/players/detail?... ` — detall del jugador

La cerca externa utilitza FC Tools Hub com a font de referència. Si la font canvia o limita peticions, el Transfer Lab continua permetent entrada manual.
