/* jshint esversion: 9 */
const { PDFDocument } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');

module.exports.run = async function (obj, date, fileName) {
    const language = obj.language || 'en';
    let suffix = '_' + language;
    suffix = '_en'; // XXX
    const existingPdfBytes = fs.readFileSync('./dpa/dpa_base'+suffix+'.pdf');

    // Load a PDFDocument from the existing PDF bytes
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    const form = pdfDoc.getForm();


    const fontBytes = await new Promise((resolve) =>
      fs.readFile('fonts/arial.ttf', (err, data) => {
        if (err) resolve(null);
        else resolve(data);
      }),
    );
    let customFont;
    if (fontBytes) {
      pdfDoc.registerFontkit(fontkit);
      await pdfDoc.embedFont(fontBytes);
      customFont = await pdfDoc.embedFont(fontBytes, {subset: true});
    }

    const rawUpdateFieldAppearances = form.updateFieldAppearances.bind(form);
    form.updateFieldAppearances = function () {
       return rawUpdateFieldAppearances(customFont);
    };

    ['name', 'name_sign', 'located_2', 'located_1', 'date',
     'represented', 'represented_sign', 'identification'].forEach(function (k) {
        const f = form.getTextField(k);
        f.acroField.setDefaultAppearance('0 0 0 rgb /F3 11 Tf'); // text color black 11px
    });

    form.getTextField('name').setText(obj.name.toUpperCase());
    form.getTextField('name_sign').setText(obj.name);
    form.getTextField('located_1').setText(obj.located_1);
    form.getTextField('located_2').setText(obj.located_2);
    form.getTextField('represented').setText(obj.represented.toUpperCase());
    form.getTextField('represented_sign').setText(obj.represented);
    form.getTextField('identification').setText(obj.identification);
    form.getTextField('date').setText(date);

    form.flatten();

    fs.writeFileSync('./dpa/'+fileName, await pdfDoc.save());
};


module.exports.remove = function (fileName) {
    fs.unlinkSync('./dpa/' + fileName);
};
