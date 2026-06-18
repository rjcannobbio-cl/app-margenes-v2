# Desplegar en Cloudflare Pages (URL para el equipo)

Objetivo: publicar la calculadora en `margenes.etbrands.cl` con la API key de Claude
**oculta en el servidor** (nadie pega keys). Tu dominio ya está en Cloudflare, así que es directo
y **no afecta** a Shopify (`etbrands.cl` / `www`) ni a ProfitGuard (`app.etbrands.cl`).

La carpeta ya incluye el proxy seguro en `functions/api/anthropic.js` (corre como Worker y guarda la key).

---

## Paso 1 — Subir el proyecto a GitHub
(Sin instalar nada; todo desde la web.)

1. Entra a https://github.com → **New repository** → nombre ej. `calculadora-margenes` → **Private** → Create.
2. En el repo vacío: **Add file → Upload files** → arrastra **todo el contenido** de esta carpeta
   (incluida la carpeta `functions/` y `data/`, `src/`, `index.html`) → **Commit changes**.

> Alternativa sin GitHub: en Cloudflare Pages puedes usar "Direct Upload", pero conectar GitHub
> es lo más confiable para que el proxy (Functions) se despliegue bien y se actualice solo.

## Paso 2 — Crear el proyecto en Cloudflare Pages
1. En Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elige el repo `calculadora-margenes`.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (vacío)
   - **Build output directory:** `/`  (la raíz)
4. **Save and Deploy.** Te queda una URL tipo `calculadora-margenes.pages.dev`.

## Paso 3 — Poner la API key (oculta)
1. En el proyecto de Pages → **Settings → Variables and Secrets → Add**.
2. Nombre: `ANTHROPIC_API_KEY` · Valor: tu key `sk-ant-…` · tipo **Secret (encrypt)**.
3. Guarda y haz **Retry deployment** (o vuelve a desplegar) para que tome la variable.

> La key vive solo en Cloudflare. En la app publicada, **deja vacío** el campo "API key" de Parámetros:
> así usa el proxy. (Solo se pega una key a mano para pruebas locales.)

## Paso 4 — Subdominio `margenes.etbrands.cl`
1. En el proyecto de Pages → **Custom domains → Set up a custom domain**.
2. Escribe `margenes.etbrands.cl` → Continúa. Como `etbrands.cl` está en Cloudflare, **crea el DNS solo**.
3. En unos minutos queda con HTTPS. Listo: comparte `https://margenes.etbrands.cl` al equipo.

## Paso 5 (opcional, recomendado) — Limitar el acceso al equipo
Para que solo entre gente de ET Brands (y proteger el endpoint de IA):
1. Cloudflare **Zero Trust → Access → Applications → Add a self-hosted app**.
2. Dominio: `margenes.etbrands.cl`.
3. Policy: permitir **emails que terminen en `@etbrands.cl`** (login con Google). Gratis hasta 50 usuarios.

---

## Base de datos en Google Drive (Excel) + lista compartida con el equipo
La "Comparación de productos evaluados" se guarda en un **Google Sheet** de tu Drive
(cada producto = una fila; se descarga como Excel desde Archivo → Descargar → .xlsx).
Así además queda **compartida**: todo el equipo ve la misma lista.

Pasos (una vez):
1. Crea un **Google Sheet** nuevo en tu Drive.
2. Abre **`google-apps-script.gs`** (en este repo) y sigue las instrucciones de su cabecera:
   pegarlo en *Extensiones → Apps Script* del Sheet y **Implementar como Aplicación web**
   (ejecutar como: Yo · acceso: Cualquier persona). Copia la URL que termina en `/exec`.
3. En Cloudflare → tu Pages → **Settings → Variables and secrets** → agrega
   **`SHEETS_WEBHOOK_URL`** = esa URL `/exec` (como Secret) y haz **Retry deployment**.

Listo: cada vez que alguien hace "+ Agregar a comparación", se escribe una fila en tu Sheet,
y la lista que ve el equipo sale de ahí. Mientras no configures `SHEETS_WEBHOOK_URL`, la app
funciona con la lista local de cada navegador (y muestra un aviso).
Recomendado combinarlo con **Cloudflare Access** (paso 5) para limitar el acceso al equipo.

## Actualizar la app después
Cada vez que cambies algo: subes los archivos al repo de GitHub (Add file → Upload / commit) y
Cloudflare **redepliega solo** en ~1 min. El subdominio y la key se mantienen.

## Notas
- Costo: Cloudflare Pages + Functions es **gratis** en este volumen. Solo pagas el uso de Claude (centavos).
- El modelo está fijo en `claude-haiku-4-5-20251001` (en `functions/api/anthropic.js` y en `src/ai.js`).
- Datos (categorías, tablas de envío) van embebidos; no hay base de datos ni backend que mantener.
