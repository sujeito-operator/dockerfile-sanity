# Every finding in here is deliberate. The credential is a documentation example from the
# AWS docs, not a live key -- it is here so CI can prove the action still fails a build.
FROM node
ARG NPM_TOKEN
ENV NPM_TOKEN=$NPM_TOKEN
ENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
RUN apt-get update && apt-get install -y curl
COPY . .
RUN npm ci
CMD ["node", "index.js"]
