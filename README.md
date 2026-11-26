# First install to init project without install nestjs locally
```sh
docker run --rm -v "${PWD}:/app" -w /app node:20-alpine npx -y @nestjs/cli new . --package-manager npm
```

# Build
```sh
docker compose up -d --build
```

# Check log NestJS
```sh
docker logs -f nest_api
```

