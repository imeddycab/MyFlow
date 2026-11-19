FROM swift:5.9-jammy AS build
WORKDIR /app
COPY Package.swift Package.resolved ./
COPY Sources ./Sources
RUN swift build -c release
COPY Public ./Public

ENV PORT=10000
EXPOSE 10000
CMD ["./.build/release/MyFlow"]
