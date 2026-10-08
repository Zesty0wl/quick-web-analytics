"""Upload an import directory (transform.py output) to R2 via its S3 API.

Usage: python -I upload.py <dir> <bucket>
Credentials come from the environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import boto3

root, bucket = sys.argv[1], sys.argv[2]
s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
)
files = [os.path.join(dp, f) for dp, _, fs in os.walk(root) for f in fs if f.endswith(".parquet")]

def put(path):
    key = os.path.relpath(path, root)
    s3.upload_file(path, bucket, key, ExtraArgs={"ContentType": "application/vnd.apache.parquet"})
    return key

with ThreadPoolExecutor(16) as pool:
    done = list(pool.map(put, files))
print(f"uploaded {len(done)} files to {bucket}")
