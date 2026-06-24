UPLOAD STRUCTURE

Copy the contents of this `upload` folder to the hosting account root.
That will overwrite/update `public_html`.

Do not put the real `.env` file in this upload folder.
On the server, keep the real `.env` next to `public_html`:

server-root/
  .env
  public_html/
    index.html
    config.php
    bootstrap.php
    ...

Use `env.example` as a visible template for creating `.env` on the server.