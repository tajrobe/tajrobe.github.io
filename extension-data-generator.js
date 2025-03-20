const fs = require('fs/promises')
const path = require('path')
const yaml = require('js-yaml')

async function getReview(filePath) {
  const rawReview = await fs.readFile(filePath, 'utf-8')
  return yaml.load(rawReview)
}

function calculateRate(reviews) {
  return (
    reviews.reduce((acc, curr) => acc + parseInt(curr.rate), 0) / reviews.length
  )
}

async function getReviewsDataFromFile(companyName) {
  try {
    const reviewsDirectoryPath = path.resolve(
      __dirname,
      '_data',
      'review',
      companyName
    )
    const reviewFileNames = await fs.readdir(reviewsDirectoryPath, {
      encoding: 'utf-8'
    })
    return Promise.all(
      reviewFileNames.map(reviewFileName =>
        getReview(path.resolve(reviewsDirectoryPath, reviewFileName))
      )
    )
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function getCompanyDataFromFile(fileName) {
  const filePath = path.resolve(__dirname, '_companies', fileName)
  const data = await fs.readFile(filePath, 'utf-8')
  const [, companyYamlData] = /---\r?\n((?:.|\r?\n)*?)\r?\n---/gim.exec(data)
  const companyData = yaml.load(companyYamlData)
  const reviews = await getReviewsDataFromFile(companyData.company_slug)
  return {
    ...companyData,
    reviews,
    totalRate: calculateRate(reviews)
  }
}

async function findCompanies() {
  const companiesFileNamesPath = path.resolve(__dirname, '_companies')
  const companiesFileNames = await fs.readdir(companiesFileNamesPath, {
    encoding: 'utf-8'
  })
  return Promise.all(companiesFileNames.map(getCompanyDataFromFile))
}

async function main() {
  const companies = await findCompanies()
  await fs.writeFile(
    path.resolve(__dirname, 'assets', 'extension-resource.json'),
    JSON.stringify(companies, null, 2)
  )
  console.log('DONE!')
}

main()
