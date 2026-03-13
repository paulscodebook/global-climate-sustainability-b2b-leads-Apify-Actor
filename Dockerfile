# First, specify the base Docker image.
# You can see the Docker images from Apify at https://hub.docker.com/r/apify/.
# You can also use any other image from Docker Hub.
FROM apify/actor-node:20 AS builder

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY package*.json ./

# Install all dependencies. Don't audit to speed up the installation.
RUN npm install --include=dev --audit=false

# Next, copy the remaining files and directories with the source code.
# Since we do this after NPM install, quick build will be really fast
# for most source file changes.
COPY . ./

# Build the TypeScript code
RUN npm run build

# Create final image
FROM apify/actor-node:20

# Copy just package.json and package-lock.json
COPY package*.json ./

# Install ONLY production dependencies.
RUN npm install --omit=dev --audit=false

# Copy built files
COPY --from=builder /usr/src/app/dist ./dist

# Run the image. If you know you won't need headful browsers,
# you can remove the --experimental-modules flag.
CMD npm start
