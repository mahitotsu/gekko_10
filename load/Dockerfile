# Load generator image: scripts/invoke.ts and scripts/suite-runner.ts, each bundled into one file (scripts/bundle-load.mjs).
# The base image comes from ECR Public so builds do not hit Docker Hub rate limits.
# The task chooses what to run through its command: ["/app/invoke.mjs", <args>] for one load run,
# ["/app/suite-runner.mjs", <plan JSON>] for a whole suite.
FROM public.ecr.aws/docker/library/node:24-slim
WORKDIR /app
COPY invoke.mjs suite-runner.mjs /app/
ENTRYPOINT ["node"]
CMD ["/app/invoke.mjs"]
