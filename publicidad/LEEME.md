# Agente de publicidad: cómo conectarlo

Todo se configura en la caja, en **Publicidad → Conexiones**. Las claves se guardan solo en esta PC (`C:\LechugaCo\data\secretos.json`) y nunca se suben a GitHub. Después de guardarlas, toca **Probar conexiones**.

## 1. Claude (el que piensa la publicidad)

1. Entra a https://console.anthropic.com y crea una cuenta de la empresa.
2. En **Billing** agrega una forma de pago. Se cobra por uso: investigar tendencias y armar una campaña cuesta pocos pesos cada vez.
3. En **API keys**, crea una clave nueva y pégala en «Clave de API de Anthropic».

## 2. Facebook e Instagram (Meta)

Requisitos: una **página de Facebook** de Lechuga & Co. y una cuenta de **Instagram de empresa** vinculada a esa página. Esto se hace en Instagram → Configuración → Tipo de cuenta.

1. Entra a https://developers.facebook.com, crea una **app** de tipo **Empresa** y agrégale los productos «Facebook Login para empresas» e «Instagram».
2. Abre **Herramientas → Explorador de la API Graph**, elige tu app y pide estos permisos:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`.
3. Genera el token, cámbialo por uno de **larga duración** (en **Herramientas → Depurador de tokens → Extender**) y consulta `me/accounts`. Ahí aparece el **token de la página** (`access_token`) y el **ID de la página** (`id`).
4. Consulta `ID-DE-LA-PAGINA?fields=instagram_business_account`. El número que regresa es el **ID de la cuenta de Instagram**.
5. Pega los tres datos en la caja.

Mientras tu app de Meta esté «en desarrollo», solo publica en las cuentas de las personas que administran la app, que en tu caso son las tuyas. Para el uso normal de tu propia página no necesitas que Meta revise la app.

## 3. TikTok

1. Entra a https://developers.tiktok.com, crea una app y agrégale **Login Kit** y **Content Posting API** con los permisos `user.info.basic` y `video.publish`.
2. Inicia sesión con tu cuenta de TikTok a través de la app para obtener el **refresh token**. Pega el **Client key**, el **Client secret** y el **refresh token** en la caja.
3. **Importante:** mientras TikTok no apruebe tu app (la «auditoría»), los videos se publican **en privado**. Solo tú los ves. Pide la auditoría en el portal de desarrolladores para publicar en público.

TikTok solo recibe videos. Las imágenes se publican en Facebook e Instagram.

## 4. Música

Los videos llevan la música que subas en **Publicidad → Música con licencia**. Usa solo pistas con derecho de uso comercial, por ejemplo:
- Biblioteca de audio de YouTube: https://studio.youtube.com, en «Biblioteca de audio».
- Pixabay Music: https://pixabay.com/music

Las canciones de moda tienen derechos de autor. Facebook, Instagram y TikTok silencian o bloquean los anuncios de empresas que las usan. Si quieres un sonido en tendencia, cada pieza trae una sugerencia de qué buscar en la **biblioteca comercial** de la red, para que lo pongas a mano desde la app.

## 5. Cómo funciona día a día

1. **Investigar tendencias:** Claude busca en internet qué formatos de publicidad de ropa funcionan ahora en México.
2. **Crear campaña:** Claude elige tus prendas con existencias y precio y escribe textos originales. La caja diseña las imágenes y los videos con tus fotos, tu logo y tus precios reales. Deja la pestaña abierta mientras se graban los videos: cada uno tarda unos 9 segundos.
3. **Publicación automática:** con el interruptor encendido, el servidor publica cada pieza a su hora, hasta el máximo diario.
4. **Revisión antes de publicar:** si una prenda se agotó, se archivó o cambió de precio, la pieza **no** se publica y queda en «Revisar» para que la rediseñes.
5. **Apagar todo:** el botón «Publicación automática» detiene cualquier publicación al instante.

La PC debe estar encendida con `iniciar.bat` para que el agente publique.
