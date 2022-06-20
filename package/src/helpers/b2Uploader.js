const MULTI_PART_UPLOAD_SIZE = 1024 * 1024 * 10;

export default class Uploader {
  constructor(apiEndpoint, prefix) {
    this.apiEndpoint = apiEndpoint;
    this.formId = prefix;
  }

  async upload(archive, handleProgress) {
    if (!archive) {
      throw new Error("No archive provided");
    }
    if (!archive.blob) {
      throw new Error("No blob provided");
    }
    if (!archive.fileName) {
      throw new Error("No fileName provided");
    }
    if (!archive.filesInfo) {
      throw new Error("No filesInfo provided");
    }
    if (!archive.password) {
      throw new Error("No password provided");
    }

    if (archive.blob.size > MULTI_PART_UPLOAD_SIZE) {
      return this.#uploadMultiPart(archive, handleProgress);
    } else {
      return this.#uploadSingleFile(archive, handleProgress);
    }
  }

  async #uploadMultiPart(archive, handleProgress) {
	try {
		let resp = await fetch(`${this.apiEndpoint}/start-upload`, {
			method: "POST",
			body: JSON.stringify({
				fileName: this.formId + "/" + archive.fileName,
				filesInfo: btoa(archive.filesInfo),
			}),
		}).then((response) => response.json());
		let uploadId = resp.fileId;

		const FILE_CHUNK_SIZE = 1024 * 1024 * 10; // 10MB
		const fileSize = archive.blob.size;
		const NUM_CHUNKS = Math.floor(fileSize / FILE_CHUNK_SIZE) + 1;
		const totalMultiUploads = NUM_CHUNKS;

		let maxSize = 30;
		let chunkNum = Math.floor(NUM_CHUNKS / maxSize);
		let partsArr = [];
		for (let i = 0; i < chunkNum + 1; i++) {
			partsArr.push(Math.min(NUM_CHUNKS - i * maxSize, maxSize));
		}

		//Fetch each item in the array
		let dataArr = [];
		for (let i = 0; i < partsArr.length; i++) {
			dataArr.push(
				fetch(
					`${this.apiEndpoint}/get-upload-url?parts=${partsArr[i]}&fileId=${uploadId}`,
				).then((response) => response.json()),
			);
		}
		dataArr = await Promise.all(dataArr);

		let converterArr = [];
		for (let i = 0; i < dataArr.length; i++) {
			converterArr.push(...Array.from(Object.values(dataArr[i])));
		}

		let dataObject = {};
		for (let i = 0; i < converterArr.length; i++) {
			dataObject[i] = converterArr[i];
		}

		let resolvedArray = [];
		let promisesArray = [];

		const keys = Object.keys(dataObject);
		let doneCount = 0;
		// Wait for blob.stream to be == to FILE_CHUNK_SIZE
		// then save chunc as blob and start upload for that part
		for (const indexStr of keys) {
			const index = parseInt(indexStr);
			const start = index * FILE_CHUNK_SIZE;
			const end = (index + 1) * FILE_CHUNK_SIZE;
			const blob =
				index < keys.length
					? archive.blob.slice(start, end)
					: archive.blob.slice(start);

			const hashBuffer = await crypto.subtle.digest(
				"SHA-1",
				await blob.arrayBuffer(),
			);
			const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
			const hashHex = hashArray
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			let uploadReq = {
				url: dataObject[index].uploadUrl,
				urlReq: {
					method: "POST",
					headers: {
						Authorization: dataObject[index].authorizationToken,
						"X-Bz-Part-Number": index + 1,
						"Content-Length": blob.size,
						"X-Bz-Content-Sha1": hashHex,
					},
					body: blob,
				},
			};

			if (promisesArray.length < 5) {
				promisesArray.push(this.#makeReq(uploadReq, "multiple", uploadId));
			} else {
				resolvedArray = [
					...resolvedArray,
					...(await Promise.all(
						promisesArray.map((p) =>
							p.then((res) => {
								doneCount++;
								console.log(`${doneCount}/${totalMultiUploads}`);
								handleProgress(Math.floor((doneCount / totalMultiUploads) * 100));
								return res;
							}),
						),
					)),
				];
				promisesArray = [];
				promisesArray.push(this.#makeReq(uploadReq, "multiple", uploadId));
			}
		}

		resolvedArray = [
			...resolvedArray,
			...(await Promise.all(
				promisesArray.map((p) =>
					p.then((res) => {
						doneCount++;
						console.log(`${doneCount}/${totalMultiUploads}`);
						handleProgress(Math.floor((doneCount / totalMultiUploads) * 100));
						return res;
					}),
				),
			)),
		];
		promisesArray = [];

		const uploadPartsArray = [];
		resolvedArray.forEach((result, index) => {
			uploadPartsArray.push(result.contentSha1);
		});

		// (3) Calls the CompleteMultipartUpload endpoint in the backend server

		let uploadReq = new Request(`${this.apiEndpoint}/complete-upload`, {
			method: "POST",
			body: JSON.stringify({
				partSha1Array: uploadPartsArray,
				fileId: uploadId,
			}),
		});
		let completeUploadResp = await fetch(uploadReq).then((response) =>
			response.json(),
		);

		const { id } = await fetch(
			`${this.apiEndpoint}/save-upload`,
			{
				method: "POST",
				body: JSON.stringify({
					fileId: completeUploadResp.data.fileId,
					formId: this.formId,
				}),
			},
		).then((response) => response.json());
		return [
			{
				uploadFileId: id,
				uploadFileKey: archive.password
			},
			null,
		];
	} catch (err) {
		return [
			null,
			{
				error: err,
			},
		];
	}
  }

  async #uploadSingleFile(archive, handleProgress) {
    try {
      let data = await fetch(`${this.apiEndpoint}/get-single-upload-url`).then(
        (response) => response.json(),
      );
      let blob = archive.blob;
      const hashBuffer = await crypto.subtle.digest(
        "SHA-1",
        await blob.arrayBuffer(),
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
      const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
  
      handleProgress(40);
  
      let uploadReq = {
        url: data.uploadUrl,
        urlReq: {
          method: "POST",
          headers: {
            Authorization: data.authorizationToken,
            "X-Bz-File-Name": this.formId + "/" + archive.fileName,
            "Content-Type": "application/zip",
            "Content-Length": blob.size,
            "X-Bz-Content-Sha1": hashHex,
            "X-Bz-Info-Files": btoa(archive.filesInfo),
          },
          body: blob,
        },
      };
  
      let completeUploadResp = await this.#makeReq(uploadReq, "single");
      handleProgress(100);
      const { id } = await fetch(
        `${this.apiEndpoint}/save-upload`,
        {
          method: "POST",
          body: JSON.stringify({
            fileId: completeUploadResp.fileId,
            formId: this.formId,
          }),
        },
      ).then((response) => response.json());
      return [
        {
          uploadFileId: id,
          uploadFileKey: archive.password
        },
        null,
      ];
    } catch (err) {
      return [
        null,
        {
          error: err,
        },
      ];
    }
  }

  #makeReq(requestObj, uploadType, uploadId = "") {
    const requestPromise = new Promise(async (resolve, reject) => {
      let result = null;
      let count = 0;
      while (!result && count < 5) {
        try {
          let request = new Request(requestObj.url, requestObj.urlReq);
          let data = await fetch(request);
          let uploadInfo;
          if (data.status == 401) {
            if (uploadType == "single") {
              uploadInfo = await fetch(
                `${this.apiEndpoint}/get-single-upload-url`,
              ).then((response) => response.json());
            } else {
              uploadInfo = await fetch(
                `${this.apiEndpoint}/get-upload-url?parts=1&fileId=${uploadId}`,
              ).then((response) => response.json());
            }
            requestObj.url = uploadInfo[0].uploadUrl;
            requestObj.urlReq.headers.Authorization =
              uploadInfo[0].authorizationToken;
          } else if (data.ok) {
            result = await data.json();
          } else {
            let retry = data.headers.get("Retry-After");
            if (retry) {
              await timeout(retry);
            } else {
              await timeout(1);
            }
            count++;
          }
        } catch (error) {
          count++;
          console.error(error);
        }
      }
      if (result) {
        resolve(result);
      } else {
        reject("error");
      }
    });
    return requestPromise;
  };
}