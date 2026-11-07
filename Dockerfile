FROM swift:5.9-jammy AS build
WORKDIR /app
COPY Package.swift Package.resolved ./
COPY Sources ./Sources
COPY Public ./Public
RUN swift build -c release

ENV PORT=10000
EXPOSE 10000
CMD ["./.build/release/MyFlow"]
