# Load generator image: scripts/invoke.ts bundled into one file (scripts/bundle-load.mjs).
# The base image comes from ECR Public so builds do not hit Docker Hub rate limits.
FROM public.ecr.aws/docker/library/node:24-slim
WORKDIR /app
COPY invoke.mjs /app/invoke.mjs
ENTRYPOINT ["node", "/app/invoke.mjs"]
